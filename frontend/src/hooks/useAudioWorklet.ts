import { useRef, useCallback } from "react";

/**
 * Hook managing the Web Audio API AudioWorklet lifecycle.
 * Creates an AudioContext, loads the cloud-daw-processor worklet,
 * and exposes a method to feed PCM data to the audio thread.
 */
export function useAudioWorklet() {
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  /** Initialize AudioContext and load the worklet processor. */
  const init = useCallback(async () => {
    if (ctxRef.current) return; // already initialized

    const ctx = new AudioContext({ sampleRate: 44100 });
    await ctx.audioWorklet.addModule("/audio-processor.js");

    const node = new AudioWorkletNode(ctx, "cloud-daw-processor");

    // Create an AnalyserNode for real-time visualization of the actual output.
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024; // 512 frequency bins — matches our wire format
    analyser.smoothingTimeConstant = 0.6;

    // Route: worklet → analyser → speakers
    node.connect(analyser);
    analyser.connect(ctx.destination);

    ctxRef.current = ctx;
    nodeRef.current = node;
    analyserRef.current = analyser;
  }, []);

  /** Send a PCM Float32Array chunk to the audio worklet for playback. */
  const feedPcm = useCallback((pcm: Float32Array) => {
    nodeRef.current?.port.postMessage(pcm);
  }, []);

  /**
   * Additively mix PCM into the ring buffer at the current playback position.
   * Used for polyphonic note preview — overlapping notes are summed together.
   */
  const mixPcm = useCallback((pcm: Float32Array) => {
    nodeRef.current?.port.postMessage({ type: "mix", pcm });
  }, []);

  /**
   * Per-voice PCM feed. Each voice (identified by MIDI note) gets its chunks
   * appended sequentially, while different voices overlap additively.
   */
  const voicePcm = useCallback((midi: number, pcm: Float32Array) => {
    nodeRef.current?.port.postMessage({ type: "voice", midi, pcm });
  }, []);

  /** Tear down the audio context. */
  const destroy = useCallback(() => {
    nodeRef.current?.disconnect();
    analyserRef.current?.disconnect();
    ctxRef.current?.close();
    ctxRef.current = null;
    nodeRef.current = null;
    analyserRef.current = null;
  }, []);

  /** Get the underlying AudioContext (for creating AudioBufferSourceNodes). */
  const getContext = useCallback(() => ctxRef.current, []);

  /** Get the AnalyserNode for real-time visualization. */
  const getAnalyser = useCallback(() => analyserRef.current, []);

  return { init, feedPcm, mixPcm, voicePcm, getContext, getAnalyser, destroy };
}
