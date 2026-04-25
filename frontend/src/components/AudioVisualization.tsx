import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

const SPECTRUM_WIDTH = 512;
const CANVAS_HEIGHT = 100;
const OSC_SAMPLES = 1024;

export interface AudioVisualizationHandle {
  updateVisualization(fft: Uint8Array, pcm: Float32Array): void;
}

/**
 * Unified FFT spectrum + oscilloscope visualization.
 * Always rendered (regardless of active tab) in a fixed top bar.
 * Uses refs + requestAnimationFrame for zero React re-renders.
 */
export const AudioVisualization = forwardRef<AudioVisualizationHandle>(
  function AudioVisualization(_props, ref) {
    const fftDataRef = useRef<Uint8Array>(new Uint8Array(SPECTRUM_WIDTH));
    const oscDataRef = useRef<Float32Array>(new Float32Array(OSC_SAMPLES));
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
      },
    }));

    useEffect(() => {
      const draw = () => {
        drawSpectrum(spectrumCanvasRef.current, fftDataRef.current);
        drawOscilloscope(oscCanvasRef.current, oscDataRef.current);
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
