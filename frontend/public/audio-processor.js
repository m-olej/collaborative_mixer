/**
 * CloudDawProcessor — AudioWorkletProcessor for Cloud DAW playback.
 *
 * Runs in the AudioWorkletGlobalScope (a dedicated audio rendering thread).
 * Receives PCM Float32 samples from the React main thread via MessagePort
 * and plays them out through a pre-allocated circular (ring) buffer.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CRITICAL PERFORMANCE RULES
 * ─────────────────────────────────────────────────────────────────────────
 * 1. NO allocations inside process().
 *    `process()` is called ~344 times/second (44100 / 128).  Any `new`,
 *    array literal `[]`, or `.slice()` call triggers the GC, causing
 *    audible clicks and pops.  All buffers are pre-allocated in the
 *    constructor and reused every call.
 *
 * 2. No DOM access, no `fetch`, no ES module imports.
 *    This file runs in AudioWorkletGlobalScope — the DOM does not exist here.
 *
 * 3. No React, no Zustand.
 *    The only communication channel with the outside world is `this.port`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * RING BUFFER DESIGN
 * ─────────────────────────────────────────────────────────────────────────
 * A single pre-allocated Float32Array of CAPACITY samples serves as the
 * circular buffer.  Two integer cursors track the state:
 *
 *   writePos  — next index to write incoming data into
 *   readPos   — next index to read from for audio output
 *   available — number of samples currently in the buffer
 *
 * Invariant: 0 <= available <= CAPACITY
 *
 * Writes (from main thread via postMessage) advance writePos modulo CAPACITY.
 * Reads (from process()) advance readPos modulo CAPACITY.
 * Both operations wrap around when they reach the end of the array, making
 * the buffer truly circular without any copy or allocation.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * MAIN THREAD INTERACTION
 * ─────────────────────────────────────────────────────────────────────────
 * The React hook (`useAudioWorklet.ts`) sends chunks like this:
 *
 *   workletNode.port.postMessage(float32Array);   // transfer semantics
 *
 * The `onmessage` handler here writes the samples into the ring buffer.
 * If the buffer is full, old samples are silently discarded to prevent
 * unbounded memory growth (back-pressure is handled by the debounce on the
 * frontend).
 */

/** Ring buffer capacity in samples.  10 s at 44 100 Hz = 441 000 samples. */
const CAPACITY = 441_000;

class CloudDawProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // ── Pre-allocated ring buffer ──────────────────────────────────────────
    // Allocated once in the constructor; never re-allocated.
    /** @type {Float32Array} Circular PCM storage. */
    this._ring = new Float32Array(CAPACITY);

    /** Index at which the next incoming sample will be written. */
    this._writePos = 0;

    /** Index from which the next output sample will be read. */
    this._readPos = 0;

    /** Number of valid, unread samples currently in the ring. */
    this._available = 0;

    // ── Message handler ────────────────────────────────────────────────────
    // Called on the audio thread when React posts a new PCM chunk.
    // This handler IS allowed to touch `this._ring` without a lock because
    // the AudioWorklet thread model guarantees that `onmessage` and `process`
    // never execute concurrently on the same processor instance.
    this.port.onmessage = (event) => {
      const data = event.data;

      // Support two message types:
      //   Float32Array         → append (legacy, sequential playback)
      //   { type: "mix", pcm } → additive mix at current writePos
      //                          (for polyphonic note preview overlay)
      if (data instanceof Float32Array) {
        this._appendToRing(data);
      } else if (data && data.type === "mix" && data.pcm instanceof Float32Array) {
        this._mixIntoRing(data.pcm);
      }
    };
  }

  /**
   * Append PCM samples sequentially to the ring buffer (existing behaviour).
   * Samples play after whatever is currently queued.
   * @param {Float32Array} incoming
   */
  _appendToRing(incoming) {
      const count = incoming.length;
      if (count === 0) return;

      // How many samples can we fit without overflowing?
      const space = CAPACITY - this._available;
      const toWrite = Math.min(count, space);

      // Write in at most two segments to handle the wrap-around.
      //   Segment A: from writePos to end of ring  (or all of toWrite)
      //   Segment B: from 0 (wrapped) to remainder (if wrap occurred)
      const segA = Math.min(toWrite, CAPACITY - this._writePos);
      const segB = toWrite - segA;

      // set() is a typed-array bulk copy — O(n) but no allocation.
      this._ring.set(incoming.subarray(0, segA), this._writePos);
      if (segB > 0) {
        this._ring.set(incoming.subarray(segA, segA + segB), 0);
      }

      this._writePos = (this._writePos + toWrite) % CAPACITY;
      this._available += toWrite;

      // Silently drop (count - toWrite) samples if ring was full.
      // This is intentional: a full ring means the client is sending faster
      // than the audio system can consume — keep the latest audio, not old.
  }

  /**
   * Additively mix PCM samples into the ring buffer starting at the
   * current read position.  Used for polyphonic note preview: multiple
   * overlapping notes are summed together in-place so they play simultaneously.
   *
   * Unlike _appendToRing, this does NOT advance writePos or increase
   * _available beyond the mix region.  The mix region extends from readPos
   * to readPos + pcm.length, expanding _available if it reaches further than
   * the current writePos.
   *
   * @param {Float32Array} pcm
   */
  _mixIntoRing(pcm) {
    const count = pcm.length;
    if (count === 0) return;

    // Mix starting at the current readPos (i.e. "now").
    // If there are already samples ahead in the buffer, add on top of them.
    // If the mix region extends beyond current _available, pad with the new
    // samples (no existing data to add to).
    for (let i = 0; i < count; i++) {
      const pos = (this._readPos + i) % CAPACITY;

      if (i < this._available) {
        // Additive mix: sum with existing buffered audio.
        this._ring[pos] += pcm[i];
      } else {
        // Beyond current buffer content: just write.
        this._ring[pos] = pcm[i];
      }
    }

    // Expand available if the mix region reaches further than current content.
    if (count > this._available) {
      // Update writePos to the end of the mix region.
      this._writePos = (this._readPos + count) % CAPACITY;
      this._available = count;
    }
  }

  /**
   * Called by the audio system ~344 times per second (128-sample quantum at
   * 44 100 Hz).  Reads from the ring buffer into the output channel.
   *
   * ALLOCATION-FREE CONTRACT: no `new`, `[]`, `.slice()`, or any object
   * construction is permitted inside this method.
   *
   * @param {Float32Array[][]} _inputs  - unused (no microphone input)
   * @param {Float32Array[][]} outputs  - output[0][0] is the mono output bus
   * @returns {boolean}  true = keep processor alive; false = destroy it
   */
  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    // Mono output bus — 128 samples per quantum (Web Audio spec default).
    const channel = output[0];
    const needed = channel.length;

    if (this._available === 0) {
      // Buffer underrun: output silence rather than undefined data.
      // fill() is in-place and allocation-free.
      channel.fill(0);
      return true;
    }

    // Read in at most two segments to handle the wrap-around.
    const toRead = Math.min(needed, this._available);
    const segA = Math.min(toRead, CAPACITY - this._readPos);
    const segB = toRead - segA;

    // Copy segment A from ring into the output channel.
    channel.set(this._ring.subarray(this._readPos, this._readPos + segA), 0);

    // Copy segment B (wrapped portion) if present.
    if (segB > 0) {
      channel.set(this._ring.subarray(0, segB), segA);
    }

    this._readPos = (this._readPos + toRead) % CAPACITY;
    this._available -= toRead;

    // Pad with silence if the ring had fewer samples than a full quantum.
    if (toRead < needed) {
      channel.fill(0, toRead);
    }

    return true; // keep the processor alive indefinitely
  }
}

registerProcessor("cloud-daw-processor", CloudDawProcessor);
