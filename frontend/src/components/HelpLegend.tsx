import { useState } from "react";

const MIXER_SHORTCUTS = [
  { key: "Space", action: "Play / Stop" },
  { key: "Click clip", action: "Select single clip" },
  { key: "Ctrl + Click", action: "Add/remove clip from selection" },
  { key: "Right-click clip", action: "Delete clip from timeline" },
  { key: "Drag clip", action: "Move clip (moves all selected if multi-select)" },
  { key: "Click ruler", action: "Seek playhead / start playback" },
  { key: "Scroll wheel", action: "Zoom timeline" },
  { key: "Drag from library", action: "Place sample on timeline" },
];

const DESIGN_SHORTCUTS = [
  { key: "Q W E R T Y U I", action: "Play synth notes (white keys)" },
  { key: "2 3 5 6 7", action: "Play synth notes (black keys)" },
  { key: "Z / X", action: "Octave down / up" },
  { key: "Enter", action: "Confirm sample name" },
];

const GENERAL_HINTS = [
  "Selected clips are highlighted with a purple border.",
  "TrackStrip controls (volume, pan, EQ, mute, solo) apply to ALL selected clips.",
  "Collaborate in real-time — changes sync across all connected users.",
  "Use the Sample Browser to drag audio samples onto the timeline.",
];

export function HelpLegend() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded bg-gray-800 px-2.5 py-1 text-xs text-gray-300 hover:bg-gray-700 hover:text-white"
        title="Keyboard shortcuts & controls"
      >
        ? Help
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setOpen(false)}>
          <div
            className="w-[520px] max-h-[80vh] overflow-y-auto rounded-xl border border-gray-700 bg-gray-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold text-white">Controls & Shortcuts</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-gray-400 hover:text-white text-lg"
              >
                ✕
              </button>
            </div>

            {/* Mixer shortcuts */}
            <Section title="Mixer View">
              {MIXER_SHORTCUTS.map((s) => (
                <ShortcutRow key={s.key} shortcut={s.key} description={s.action} />
              ))}
            </Section>

            {/* Design shortcuts */}
            <Section title="Design View (Synth Keyboard)">
              {DESIGN_SHORTCUTS.map((s) => (
                <ShortcutRow key={s.key} shortcut={s.key} description={s.action} />
              ))}
            </Section>

            {/* General hints */}
            <Section title="Tips">
              <ul className="space-y-1.5">
                {GENERAL_HINTS.map((hint, i) => (
                  <li key={i} className="flex gap-2 text-xs text-gray-300">
                    <span className="mt-0.5 text-indigo-400">•</span>
                    {hint}
                  </li>
                ))}
              </ul>
            </Section>
          </div>
        </div>
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h3 className="mb-2 text-xs font-bold uppercase tracking-widest text-indigo-400">{title}</h3>
      {children}
    </div>
  );
}

function ShortcutRow({ shortcut, description }: { shortcut: string; description: string }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <kbd className="inline-block min-w-[90px] shrink-0 rounded bg-gray-800 px-2 py-0.5 text-center text-[11px] font-mono text-gray-200 border border-gray-700">
        {shortcut}
      </kbd>
      <span className="text-xs text-gray-400">{description}</span>
    </div>
  );
}
