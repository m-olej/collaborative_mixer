/**
 * AdsrEnvelope — Interactive ADSR envelope visualisation and controls.
 *
 * Renders a `<canvas>` showing the envelope shape and 4 sliders for
 * Attack, Decay, Sustain and Release. The canvas updates in real-time
 * as the user drags the sliders.
 */

import { useCallback, useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdsrParams {
  attack_ms: number;
  decay_ms: number;
  sustain: number;
  release_ms: number;
}

interface AdsrEnvelopeProps {
  label: string;
  params: AdsrParams;
  onChange: (key: keyof AdsrParams, value: number) => void;
  /** Optional: filter envelope depth slider (only for filter tab). */
  envDepth?: number;
  onEnvDepthChange?: (value: number) => void;
}

// ---------------------------------------------------------------------------
// Canvas drawing
// ---------------------------------------------------------------------------

const CANVAS_W = 320;
const CANVAS_H = 100;
const LABEL_H = 16;
const PAD_X = 8;
const PAD_Y = 8;

function drawEnvelope(
  ctx: CanvasRenderingContext2D,
  params: AdsrParams,
  accentColor: string,
) {
  const w = CANVAS_W - PAD_X * 2;
  const h = CANVAS_H - PAD_Y * 2;

  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H + LABEL_H);

  // Background grid
  ctx.strokeStyle = "rgba(75,85,99,0.25)";
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = PAD_Y + (h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(PAD_X, y);
    ctx.lineTo(PAD_X + w, y);
    ctx.stroke();
  }

  // Time proportions — use fixed sustain display width so the envelope shape
  // doesn't misleadingly change when adjusting A/D/R.
  const SUSTAIN_DISPLAY_MS = 300;
  const totalMs = params.attack_ms + params.decay_ms + SUSTAIN_DISPLAY_MS + params.release_ms;
  const safeTotal = Math.max(totalMs, 1); // avoid division by zero
  const aPx = (params.attack_ms / safeTotal) * w;
  const dPx = (params.decay_ms / safeTotal) * w;
  const sPx = (SUSTAIN_DISPLAY_MS / safeTotal) * w;
  const rPx = (params.release_ms / safeTotal) * w;

  const x0 = PAD_X;
  const yBottom = PAD_Y + h;
  const yTop = PAD_Y;
  const ySustain = PAD_Y + h * (1 - params.sustain);

  // Draw envelope path
  ctx.beginPath();
  ctx.moveTo(x0, yBottom);

  // Attack: 0 → 1
  ctx.lineTo(x0 + aPx, yTop);

  // Decay: 1 → sustain (exponential curve approximation)
  const decaySteps = 20;
  for (let i = 1; i <= decaySteps; i++) {
    const t = i / decaySteps;
    const level = params.sustain + (1 - params.sustain) * Math.exp(-5 * t);
    const x = x0 + aPx + dPx * t;
    const y = PAD_Y + h * (1 - level);
    ctx.lineTo(x, y);
  }

  // Sustain hold
  ctx.lineTo(x0 + aPx + dPx + sPx, ySustain);

  // Release: sustain → 0 (exponential)
  const releaseSteps = 20;
  for (let i = 1; i <= releaseSteps; i++) {
    const t = i / releaseSteps;
    const level = params.sustain * Math.exp(-5 * t);
    const x = x0 + aPx + dPx + sPx + rPx * t;
    const y = PAD_Y + h * (1 - level);
    ctx.lineTo(x, y);
  }

  // Stroke
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Fill under curve
  ctx.lineTo(x0 + aPx + dPx + sPx + rPx, yBottom);
  ctx.closePath();
  ctx.fillStyle = accentColor.replace(")", ", 0.1)").replace("rgb(", "rgba(");
  ctx.fill();

  // Phase labels
  ctx.fillStyle = "rgba(156,163,175,0.5)";
  ctx.font = "9px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("A", x0 + aPx / 2, yBottom + 12);
  ctx.fillText("D", x0 + aPx + dPx / 2, yBottom + 12);
  ctx.fillText("S", x0 + aPx + dPx + sPx / 2, yBottom + 12);
  ctx.fillText("R", x0 + aPx + dPx + sPx + rPx / 2, yBottom + 12);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AdsrEnvelope({
  label,
  params,
  onChange,
  envDepth,
  onEnvDepthChange,
}: AdsrEnvelopeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const accentColor = label === "AMP" ? "rgb(99,102,241)" : "rgb(234,179,8)";

  // Redraw on param change
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    drawEnvelope(ctx, params, accentColor);
  }, [params, accentColor]);

  const handleSlider = useCallback(
    (key: keyof AdsrParams, value: number) => {
      onChange(key, value);
    },
    [onChange],
  );

  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-[10px] font-bold uppercase tracking-widest text-gray-500">
        {label}
      </h4>

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H + 16}
        className="w-full rounded bg-gray-900/50"
        style={{ maxWidth: CANVAS_W }}
      />

      {/* Sliders */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <TimeSlider
          label="Attack"
          value={params.attack_ms}
          onChange={(v) => handleSlider("attack_ms", v)}
        />
        <TimeSlider
          label="Decay"
          value={params.decay_ms}
          onChange={(v) => handleSlider("decay_ms", v)}
        />
        <LevelSlider
          label="Sustain"
          value={params.sustain}
          onChange={(v) => handleSlider("sustain", v)}
        />
        <TimeSlider
          label="Release"
          value={params.release_ms}
          onChange={(v) => handleSlider("release_ms", v)}
        />
      </div>

      {/* Filter envelope depth (only shown for filter tab) */}
      {envDepth !== undefined && onEnvDepthChange && (
        <div className="mt-1">
          <div className="flex justify-between text-[11px]">
            <span className="text-gray-400">Env Depth</span>
            <span className="tabular-nums text-gray-300">
              {envDepth.toFixed(0)}
              <span className="ml-0.5 text-gray-500">Hz</span>
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={8000}
            step={10}
            value={envDepth}
            onChange={(e) => onEnvDepthChange(parseFloat(e.target.value))}
            className="h-1 w-full cursor-pointer appearance-none rounded bg-gray-700 accent-yellow-500"
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Time slider (0–5000ms) with logarithmic feel via a curved mapping. */
function TimeSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  // Map 0–1 slider to 0–5000ms with a logarithmic curve
  const sliderToMs = (t: number) => {
    const curved = t * t; // quadratic for pseudo-log feel
    return curved * 5000;
  };
  const msToSlider = (ms: number) => Math.sqrt(ms / 5000);

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex justify-between text-[11px]">
        <span className="text-gray-400">{label}</span>
        <span className="tabular-nums text-gray-300">
          {value < 1000 ? `${value.toFixed(0)}ms` : `${(value / 1000).toFixed(2)}s`}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={msToSlider(value)}
        onChange={(e) => onChange(sliderToMs(parseFloat(e.target.value)))}
        className="h-1 w-full cursor-pointer appearance-none rounded bg-gray-700 accent-indigo-500"
      />
    </div>
  );
}

/** Linear level slider (0–1). */
function LevelSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex justify-between text-[11px]">
        <span className="text-gray-400">{label}</span>
        <span className="tabular-nums text-gray-300">{value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded bg-gray-700 accent-indigo-500"
      />
    </div>
  );
}
