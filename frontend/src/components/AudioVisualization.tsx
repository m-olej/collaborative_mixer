import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

const SPECTRUM_WIDTH = 512;
const CANVAS_HEIGHT = 100;
const OSC_SAMPLES = 1024;
/** Frames of silence before we start fading the visualization. */
const SILENCE_THRESHOLD_FRAMES = 30;
/** Per-frame multiplier to decay stale FFT data (lower = faster fade). */
const DECAY_FACTOR = 0.92;

export interface AudioVisualizationHandle {
  updateVisualization(fft: Uint8Array, pcm: Float32Array): void;
  setAnalyser(analyser: AnalyserNode | null): void;
}

/**
 * Unified FFT spectrum + oscilloscope visualization.
 * Always rendered (regardless of active tab) in a fixed top bar.
 *
 * Two data sources, in order of priority:
 * 1. **AnalyserNode** — reads the actual mixed audio output in real-time.
 *    Available when an AudioWorklet is active (Design view with keyboard).
 * 2. **Manual feed** — `updateVisualization(fft, pcm)` called by socket
 *    handlers for non-worklet audio (Mixer view playback, etc.).
 *
 * Uses refs + requestAnimationFrame for zero React re-renders.
 */
export const AudioVisualization = forwardRef<AudioVisualizationHandle>(
  function AudioVisualization(_props, ref) {
    const analyserRef = useRef<AnalyserNode | null>(null);
    // Pre-allocated typed arrays for AnalyserNode reads (no allocation in rAF).
    const analyserFftBuf = useRef<Uint8Array | null>(null);
    const analyserTimeBuf = useRef<Float32Array | null>(null);

    // Fallback: manual feed from socket handlers.
    const fftDataRef = useRef<Uint8Array>(new Uint8Array(SPECTRUM_WIDTH));
    const oscDataRef = useRef<Float32Array>(new Float32Array(OSC_SAMPLES));
    /** Counts frames since last manual update to enable decay. */
    const silenceFrames = useRef<number>(SILENCE_THRESHOLD_FRAMES + 1);

    const animFrameRef = useRef<number>(0);
    const spectrumCanvasRef = useRef<HTMLCanvasElement>(null);
    const oscCanvasRef = useRef<HTMLCanvasElement>(null);

    useImperativeHandle(ref, () => ({
      updateVisualization(fft: Uint8Array, pcm: Float32Array) {
        fftDataRef.current = fft;
        const copyLen = Math.min(pcm.length, OSC_SAMPLES);
        oscDataRef.current.set(pcm.subarray(0, copyLen), 0);
        if (copyLen < OSC_SAMPLES) {
          oscDataRef.current.fill(0, copyLen);
        }
        silenceFrames.current = 0;
      },
      setAnalyser(analyser: AnalyserNode | null) {
        analyserRef.current = analyser;
        if (analyser) {
          const bins = analyser.frequencyBinCount; // fftSize / 2
          analyserFftBuf.current = new Uint8Array(bins);
          analyserTimeBuf.current = new Float32Array(bins);
        } else {
          analyserFftBuf.current = null;
          analyserTimeBuf.current = null;
        }
      },
    }));

    useEffect(() => {
      const draw = () => {
        const analyser = analyserRef.current;
        const fftBuf = analyserFftBuf.current;
        const timeBuf = analyserTimeBuf.current;

        if (analyser && fftBuf && timeBuf) {
          // Primary: read from AnalyserNode (real-time aggregated output).
          analyser.getByteFrequencyData(fftBuf);
          analyser.getFloatTimeDomainData(timeBuf);
          drawSpectrum(spectrumCanvasRef.current, fftBuf);
          drawOscilloscope(oscCanvasRef.current, timeBuf);
        } else {
          // Fallback: use manually-fed data from socket frames.
          silenceFrames.current++;

          if (silenceFrames.current > SILENCE_THRESHOLD_FRAMES) {
            // Decay: gradually fade the FFT bars to zero.
            const fft = fftDataRef.current;
            let hasContent = false;
            for (let i = 0; i < fft.length; i++) {
              fft[i] = Math.floor(fft[i] * DECAY_FACTOR);
              if (fft[i] > 0) hasContent = true;
            }
            if (!hasContent) {
              // Also decay oscilloscope to center line.
              const osc = oscDataRef.current;
              for (let i = 0; i < osc.length; i++) {
                osc[i] *= DECAY_FACTOR;
              }
            }
          }

          drawSpectrum(spectrumCanvasRef.current, fftDataRef.current);
          drawOscilloscope(oscCanvasRef.current, oscDataRef.current);
        }

        animFrameRef.current = requestAnimationFrame(draw);
      };
      animFrameRef.current = requestAnimationFrame(draw);
      return () => cancelAnimationFrame(animFrameRef.current);
    }, []);

    return (
      <div className="flex gap-3 border-b border-gray-800 bg-gray-900/60 px-4 py-2">
        <div className="flex-1">
          <label className="text-[10px] uppercase tracking-widest text-gray-500">
            Spectrum
          </label>
          <canvas
            ref={spectrumCanvasRef}
            width={SPECTRUM_WIDTH}
            height={CANVAS_HEIGHT}
            className="w-full rounded bg-gray-950"
          />
        </div>
        <div className="flex-1">
          <label className="text-[10px] uppercase tracking-widest text-gray-500">
            Oscilloscope
          </label>
          <canvas
            ref={oscCanvasRef}
            width={SPECTRUM_WIDTH}
            height={CANVAS_HEIGHT}
            className="w-full rounded bg-gray-950"
          />
        </div>
      </div>
    );
  },
);

// ---------------------------------------------------------------------------
// Canvas drawing helpers (extracted from SynthControls)
// ---------------------------------------------------------------------------

function drawSpectrum(canvas: HTMLCanvasElement | null, data: Uint8Array): void {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  const barWidth = W / data.length;

  ctx.clearRect(0, 0, W, H);

  for (let i = 0; i < data.length; i++) {
    const barH = (data[i] / 255) * H;
    const hue = (i / data.length) * 240;
    ctx.fillStyle = `hsl(${hue}, 80%, 55%)`;
    ctx.fillRect(i * barWidth, H - barH, barWidth - 0.5, barH);
  }
}

function drawOscilloscope(canvas: HTMLCanvasElement | null, data: Float32Array): void {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  const midY = H / 2;

  ctx.clearRect(0, 0, W, H);

  ctx.strokeStyle = "#374151";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(W, midY);
  ctx.stroke();

  if (data.length === 0) return;

  ctx.strokeStyle = "#6366f1";
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  const step = W / data.length;
  for (let i = 0; i < data.length; i++) {
    const y = midY - data[i] * midY * 0.9;
    if (i === 0) {
      ctx.moveTo(0, y);
    } else {
      ctx.lineTo(i * step, y);
    }
  }

  ctx.stroke();
}
