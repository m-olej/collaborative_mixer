/**
 * useMetronome — Count-in metronome click generator.
 *
 * Generates a full count-in bar of click sounds as a Float32Array and feeds
 * it through the AudioWorklet in one chunk for sample-accurate timing.
 *
 * The click is a short sine burst (1 kHz, 15 ms) with exponential decay,
 * generated entirely in JavaScript. This is the ONE exception to the
 * "no client-side DSP" rule — metronome clicks are static sounds, not
 * synthesizer processing.
 */

import { useCallback, useRef } from "react";
import type { CountInNoteValue } from "../types/daw";
import { barDurationMs, clicksPerBar } from "../types/daw";

const SAMPLE_RATE = 44100;
const CLICK_DURATION_MS = 15;
const CLICK_FREQUENCY = 1000; // Hz
const CLICK_SAMPLES = Math.ceil(SAMPLE_RATE * (CLICK_DURATION_MS / 1000));

/** Generate a single click sound (short sine burst with exponential decay). */
function generateClick(): Float32Array {
  const click = new Float32Array(CLICK_SAMPLES);
  for (let i = 0; i < CLICK_SAMPLES; i++) {
    const t = i / SAMPLE_RATE;
    const envelope = Math.exp(-t * 300); // fast decay
    click[i] = Math.sin(2 * Math.PI * CLICK_FREQUENCY * t) * envelope * 0.5;
  }
  return click;
}

/** Pre-generate the click sound once. */
const CLICK_SOUND = generateClick();

export interface MetronomeOptions {
  bpm: number;
  timeSignature: string;
  countInNoteValue: CountInNoteValue;
}

export function useMetronome() {
  const abortRef = useRef(false);

  /**
   * Generate a complete count-in bar as a single Float32Array.
   *
   * Returns the PCM data that should be fed to the AudioWorklet, plus
   * the bar duration in milliseconds.
   */
  const generateCountIn = useCallback(
    (opts: MetronomeOptions): { pcm: Float32Array; durationMs: number } => {
      const durationMs = barDurationMs(opts.bpm, opts.timeSignature);
      const totalSamples = Math.ceil(SAMPLE_RATE * (durationMs / 1000));
      const numClicks = clicksPerBar(opts.timeSignature, opts.countInNoteValue);
      const intervalSamples = Math.floor(totalSamples / numClicks);

      const pcm = new Float32Array(totalSamples);

      for (let c = 0; c < numClicks; c++) {
        const offset = c * intervalSamples;
        for (let i = 0; i < CLICK_SOUND.length; i++) {
          const pos = offset + i;
          if (pos < totalSamples) {
            pcm[pos] += CLICK_SOUND[i];
          }
        }
      }

      return { pcm, durationMs };
    },
    [],
  );

  /**
   * Play the count-in and resolve when it finishes.
   *
   * Feeds the entire count-in PCM to the AudioWorklet at once, then waits
   * for the bar duration to elapse before resolving.
   */
  const playCountIn = useCallback(
    (
      feedPcm: (pcm: Float32Array) => void,
      opts: MetronomeOptions,
    ): Promise<void> => {
      abortRef.current = false;
      const { pcm, durationMs } = generateCountIn(opts);
      feedPcm(pcm);

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (!abortRef.current) resolve();
        }, durationMs);

        // Allow abort
        const check = setInterval(() => {
          if (abortRef.current) {
            clearTimeout(timeout);
            clearInterval(check);
            resolve();
          }
        }, 50);

        // Clean up interval when timeout fires
        setTimeout(() => clearInterval(check), durationMs + 100);
      });
    },
    [generateCountIn],
  );

  const abort = useCallback(() => {
    abortRef.current = true;
  }, []);

  return { playCountIn, generateCountIn, abort };
}
