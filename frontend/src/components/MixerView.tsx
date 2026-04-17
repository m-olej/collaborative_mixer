import { useEffect } from "react";
import { useSocketStore } from "../store/useSocketStore";
import { SpectrumCanvas } from "./SpectrumCanvas";

/** Mixer view for a single project session. Shows connection status and spectrum. */
export function MixerView({ projectId }: { projectId: number }) {
  const { connect, disconnect, connected, mixerState } = useSocketStore();

  useEffect(() => {
    connect(projectId);
    return () => disconnect();
  }, [projectId, connect, disconnect]);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <div
          className={`h-3 w-3 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`}
        />
        <span className="text-sm text-gray-300">
          {connected ? "Connected" : "Disconnected"}
        </span>
        {mixerState && (
          <span className="ml-auto text-xs text-gray-500">
            Project #{mixerState.project_id} · Master: {Math.round(mixerState.master_volume * 100)}%
          </span>
        )}
      </div>

      <SpectrumCanvas />

      <div className="rounded bg-gray-800 p-4 text-sm text-gray-400">
        {connected
          ? "WebSocket channel joined. Mixer state synchronized."
          : "Connecting to project session..."}
      </div>
    </div>
  );
}
