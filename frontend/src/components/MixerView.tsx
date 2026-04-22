import type { Project } from "../types/daw";
import { useSocketStore } from "../store/useSocketStore";
import { SpectrumCanvas } from "./SpectrumCanvas";
import { TrackStrip } from "./Mixer/TrackStrip";
import { MasterBus } from "./Mixer/MasterBus";
import { SampleBrowser } from "./Mixer/SampleBrowser";

interface MixerViewProps {
  project: Project;
}

/**
 * Mixer view for a single project session.
 *
 * Layout:
 *  ┌─────────────────────────────────────────┐
 *  │  Spectrum visualiser (full width)        │
 *  ├──────────────────────────┬──────────────┤
 *  │  Track strips + Master   │ Sample library│
 *  │  (horizontal scroll)     │ (sidebar)     │
 *  └──────────────────────────┴──────────────┘
 *
 * The WebSocket connection is owned by ProjectWorkspace, not this component.
 * This component only reads from useSocketStore.
 */
export function MixerView({ project }: MixerViewProps) {
  const { channel, mixerState } = useSocketStore();

  const trackIds = mixerState ? Object.keys(mixerState.tracks) : [];

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 88px)" }}>
      {/* ── Spectrum visualiser ─────────────────────────────────────────── */}
      <div className="border-b border-gray-800 px-4 py-3">
        <p className="mb-1 text-[10px] uppercase tracking-widest text-gray-500">
          Master Spectrum
        </p>
        <SpectrumCanvas />
      </div>

      {/* ── Main area ───────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Track strips — horizontal scrollable channel area */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="border-b border-gray-800 px-4 py-2">
            <p className="text-xs text-gray-500">
              {trackIds.length === 0
                ? "No tracks — add samples from the library"
                : `${trackIds.length} track${trackIds.length !== 1 ? "s" : ""}`}
            </p>
          </div>

          <div className="flex flex-1 gap-3 overflow-x-auto p-4">
            {trackIds.map((id) => (
              <TrackStrip
                key={id}
                trackId={id}
                initial={mixerState!.tracks[id]}
                channel={channel}
              />
            ))}

            {/* Master bus — always last in the strip row */}
            <MasterBus
              masterVolume={mixerState?.master_volume ?? 1.0}
              playing={mixerState?.playing ?? false}
              bpm={project.bpm}
              channel={channel}
            />
          </div>
        </div>

        {/* Sample browser sidebar */}
        <div className="w-64 shrink-0 overflow-y-auto border-l border-gray-800">
          <SampleBrowser />
        </div>
      </div>
    </div>
  );
}

