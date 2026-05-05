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

    /**
     * Per-voice write cursors. Maps MIDI note → absolute write position for
     * that voice. Burst + pace chunks from the same voice are appended
     * sequentially, while different voices overlap additively.
     * @type {Map<number, number>}
     */
    this._voices = new Map();

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
      //   { type: "voice", midi, pcm } → per-voice tracked mix
      //                          (burst + pace chunks appended per voice,
      //                           overlapping with other voices)
      if (data instanceof Float32Array) {
        this._appendToRing(data);
      } else if (data && data.type === "voice" && typeof data.midi === "number" && data.pcm instanceof Float32Array) {
        this._voiceMix(data.midi, data.pcm);
      } else if (data && data.type === "mix" && data.pcm instanceof Float32Array) {
        this._voiceMix(0, data.pcm);
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
   * Per-voice additive mix into the ring buffer.
   *
   * Each voice has its own write cursor (stored in `_voices`).  The first
   * chunk for a voice (burst) starts writing at the current **read** position
   * so that its audio plays immediately (overlapping with any other voices
   * currently in the buffer).  Subsequent chunks (pace) continue from where
   * the previous chunk ended, maintaining sequential continuity for that voice.
   *
   * When a voice's cursor falls behind the read pointer (already consumed),
   * it is reset to the current read position.
   *
   * @param {number} midi MIDI note number (voice identifier)
   * @param {Float32Array} pcm Samples to mix in
   */
  _voiceMix(midi, pcm) {
    const count = pcm.length;
    if (count === 0) return;

    // Determine this voice's write start position.
    let voicePos = this._voices.get(midi);

    // If the voice has no cursor, or its cursor is behind the read pointer
    // (its audio was already consumed), start from the current read position
    // so audio plays as soon as possible (minimal latency).
    if (voicePos === undefined || !this._isAheadOfRead(voicePos)) {
      voicePos = this._readPos;
    }

    // Mix the PCM samples into the ring at voicePos.
    for (let i = 0; i < count; i++) {
      const pos = (voicePos + i) % CAPACITY;

      // Is this position within the already-buffered region?
      const distFromRead = (pos - this._readPos + CAPACITY) % CAPACITY;
      if (distFromRead < this._available) {
        // Additive mix with existing audio (other voices already wrote here).
        this._ring[pos] += pcm[i];
      } else {
        // New territory: just write (no existing data).
        this._ring[pos] = pcm[i];
      }
    }

    // Advance this voice's cursor.
    const newVoicePos = (voicePos + count) % CAPACITY;
    this._voices.set(midi, newVoicePos);

    // Expand the global buffer extent if this voice wrote past the current extent.
    const voiceEnd = (voicePos + count - this._readPos + CAPACITY) % CAPACITY;
    const currentExtent = this._available;
    if (voiceEnd > currentExtent) {
      this._available = voiceEnd;
      this._writePos = (this._readPos + voiceEnd) % CAPACITY;
    }
  }

  /**
   * Check if a ring buffer position is ahead of (or at) the read pointer.
   * "Ahead" means it hasn't been consumed yet.
   * @param {number} pos
   * @returns {boolean}
   */
  _isAheadOfRead(pos) {
    if (this._available === 0) return false;
    const dist = (pos - this._readPos + CAPACITY) % CAPACITY;
    return dist > 0 && dist <= this._available;
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
    // Zero out consumed region to prevent stale data in additive mix.
    this._ring.fill(0, this._readPos, this._readPos + segA);

    // Copy segment B (wrapped portion) if present.
    if (segB > 0) {
      channel.set(this._ring.subarray(0, segB), segA);
      this._ring.fill(0, 0, segB);
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
