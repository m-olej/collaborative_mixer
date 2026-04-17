/**
 * AudioWorkletProcessor for Cloud DAW playback.
 *
 * Runs in the AudioWorkletGlobalScope (dedicated audio thread).
 * Receives PCM Float32 samples from the main thread via MessagePort
 * and fills the audio output buffers from an internal ring buffer.
 *
 * RULES:
 * - No DOM access, no fetch, no ES module imports.
 * - No React, no Zustand — this file is isolated from the app bundle.
 */

class CloudDawProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {Float32Array[]} Ring buffer of PCM chunks */
    this._queue = [];
    this.port.onmessage = (event) => {
      if (event.data instanceof Float32Array) {
        this._queue.push(event.data);
      }
    };
  }

  /**
   * Called ~every 128 samples by the audio system.
   * @param {Float32Array[][]} _inputs  - unused (no mic input)
   * @param {Float32Array[][]} outputs  - output channels to fill
   * @returns {boolean} true to keep the processor alive
   */
  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const channel = output[0]; // mono output
    let written = 0;

    while (written < channel.length && this._queue.length > 0) {
      const chunk = this._queue[0];
      const available = chunk.length;
      const needed = channel.length - written;
      const toCopy = Math.min(available, needed);

      channel.set(chunk.subarray(0, toCopy), written);
      written += toCopy;

      if (toCopy >= available) {
        // Consumed the entire chunk
        this._queue.shift();
      } else {
        // Partial consumption — keep remainder for next call
        this._queue[0] = chunk.subarray(toCopy);
      }
    }

    // Fill any remaining space with silence
    if (written < channel.length) {
      channel.fill(0, written);
    }

    return true;
  }
}

registerProcessor("cloud-daw-processor", CloudDawProcessor);
