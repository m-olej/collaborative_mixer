import { useCallback, useEffect, useState } from "react";
import type { Project, Sample } from "../types/daw";
import { useSocketStore } from "../store/useSocketStore";
import { useTimelineStore } from "../store/useTimelineStore";
import { TrackStrip } from "./Mixer/TrackStrip";
import { MasterBus } from "./Mixer/MasterBus";
import { SampleBrowser } from "./Mixer/SampleBrowser";
import { Timeline } from "./Mixer/Timeline";
import { api } from "../api/rest";

interface MixerViewProps {
  project: Project;
}

/**
 * Mixer view for a single project session.
 *
 * Layout:
 *  ┌──────────────────────────────────────────────┬──────────────┐
 *  │  Timeline (beat grid + lanes + clips)        │ Sample       │
 *  │  (scrollable)                                │ Browser      │
 *  ├──────────────────────────────────────────────┤ (sidebar)    │
 *  │  Track strips (vol/pan/EQ) + Master          │              │
 *  │  (horizontal scroll, fixed ~200px)           │              │
 *  └──────────────────────────────────────────────┴──────────────┘
 *
 * The WebSocket connection is owned by ProjectWorkspace, not this component.
 */
export function MixerView({ project }: MixerViewProps) {
  const { channel, mixerState } = useSocketStore();
  const [samples, setSamples] = useState<Sample[]>([]);
  const tracks = useTimelineStore((s) => s.tracks);

  // Refresh the sample cache from the REST API.
  const refreshSamples = useCallback(() => {
    api.listSamples(1, 200).then((res) => setSamples(res.data));
  }, []);

  // Load samples on mount.
  useEffect(() => { refreshSamples(); }, [refreshSamples]);

  // Re-fetch samples whenever the track list changes (a new track may reference
  // a sample that wasn't in the cache yet).
  useEffect(() => { refreshSamples(); }, [tracks.length, refreshSamples]);

  const trackIds = mixerState ? Object.keys(mixerState.tracks) : [];

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 88px)" }}>
      {/* ── Main area ───────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left: Timeline + Track strips */}
        <div className="flex flex-1 flex-col overflow-hidden">

          {/* Timeline */}
          <div className="flex-1 overflow-hidden">
            <Timeline project={project} samples={samples} />
          </div>

          {/* Track strips */}
          <div className="shrink-0 border-t border-gray-800 bg-black/20">
            <div className="border-b border-gray-800 px-4 py-1">
              <p className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                {trackIds.length === 0
                  ? "No tracks — drag samples from the library onto the timeline"
                  : `${trackIds.length} track${trackIds.length !== 1 ? "s" : ""}`}
              </p>
            </div>

            <div className="flex gap-3 overflow-x-auto p-4">
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
        </div>

        {/* Sample browser sidebar */}
        <div className="w-64 shrink-0 overflow-y-auto border-l border-gray-800">
          <SampleBrowser />
        </div>
      </div>
    </div>
  );
}

