import { useRef, useEffect } from "react";

/**
 * Real-time FFT spectrum visualizer drawn on a <canvas> element.
 * Uses useRef + requestAnimationFrame — never triggers React re-renders.
 */
export function SpectrumCanvas({ width = 512, height = 200 }: { width?: number; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fftDataRef = useRef<Uint8Array>(new Uint8Array(512));
  const animFrameRef = useRef<number>(0);

  /** Call this from the WebSocket binary handler to update FFT data. */
  // Exposed via ref so parent can call it without re-render
  useEffect(() => {
    // Store updater on the canvas DOM element for external access
    const canvas = canvasRef.current;
    if (canvas) {
      (canvas as unknown as Record<string, unknown>)._updateFft = (data: Uint8Array) => {
        fftDataRef.current = data;
      };
    }
  }, []);

  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const data = fftDataRef.current;
      const W = canvas.width;
      const H = canvas.height;
      const barWidth = W / data.length;

      ctx.clearRect(0, 0, W, H);

      for (let i = 0; i < data.length; i++) {
        const barH = (data[i] / 255) * H;
        const hue = (i / data.length) * 240;
        ctx.fillStyle = `hsl(${hue}, 80%, 60%)`;
        ctx.fillRect(i * barWidth, H - barH, barWidth - 1, barH);
      }

      animFrameRef.current = requestAnimationFrame(draw);
    };

    animFrameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className="w-full rounded bg-gray-900"
    />
  );
}
