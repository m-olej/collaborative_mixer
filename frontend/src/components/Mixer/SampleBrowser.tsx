import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/rest";
import type { Sample } from "../../types/daw";
import { useCollabStore } from "../../store/useCollabStore";
import { useSocketStore } from "../../store/useSocketStore";

const PAGE_SIZE = 20;

/**
 * Paginated sample library browser.
 * Loads from GET /api/samples and displays name, genre, and duration.
 * Refreshes automatically when mounted (e.g. after saving a new sample from
 * the Design view).
 */
export function SampleBrowser() {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(async (p: number) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listSamples(p, PAGE_SIZE);
      setSamples(result.data);
      setTotal(result.total);
      setPage(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPage(1);
  }, [loadPage]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-gray-800 px-4 py-3">
        <h3 className="text-sm font-semibold text-gray-200">Sample Library</h3>
        <p className="mt-0.5 text-[11px] text-gray-500">{total} samples</p>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <p className="p-4 text-xs text-gray-500">Loading…</p>
        )}

        {error && (
          <p className="p-4 text-xs text-red-400">{error}</p>
        )}

        {!loading && !error && samples.length === 0 && (
          <p className="p-4 text-xs text-gray-500">
            No samples yet. Design one and save it to the library.
          </p>
        )}

        {!loading && samples.length > 0 && (
          <ul className="divide-y divide-gray-800">
            {samples.map((s) => (
              <SampleRow key={s.id} sample={s} />
            ))}
          </ul>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-gray-800 px-3 py-2">
          <button
            type="button"
            disabled={page <= 1 || loading}
            onClick={() => loadPage(page - 1)}
            className="text-xs text-gray-400 hover:text-white disabled:opacity-30"
          >
            ← Prev
          </button>
          <span className="text-xs text-gray-500">
            {page} / {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages || loading}
            onClick={() => loadPage(page + 1)}
            className="text-xs text-gray-400 hover:text-white disabled:opacity-30"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SampleRow
// ---------------------------------------------------------------------------

function SampleRow({ sample }: { sample: Sample }) {
  const { localSelection, setLocalSelection, remoteUsers } = useCollabStore();
  const pushSelectionUpdate = useSocketStore((s) => s.pushSelectionUpdate);

  const duration =
    sample.duration_ms != null
      ? `${(sample.duration_ms / 1000).toFixed(1)}s`
      : "—";

  const isSelected =
    localSelection?.type === "library_sample" && localSelection.id === sample.id;
  const remoteSelectors = Object.values(remoteUsers).filter(
    (u) => u.selection?.type === "library_sample" && u.selection.id === sample.id,
  );

  const borderColor = isSelected
    ? "#6366f1"
    : remoteSelectors.length > 0
      ? remoteSelectors[0].color
      : undefined;

  const handleClick = () => {
    const sel = isSelected ? null : { type: "library_sample" as const, id: sample.id };
    setLocalSelection(sel);
    pushSelectionUpdate(sel);
  };

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("application/json", JSON.stringify(sample));
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <li
      draggable
      onDragStart={handleDragStart}
      onClick={handleClick}
      className="flex cursor-grab items-center gap-2 px-4 py-2.5 hover:bg-gray-800"
      style={borderColor ? { outline: `2px solid ${borderColor}`, outlineOffset: -2, borderRadius: 4 } : undefined}
    >
      {/* Waveform icon placeholder */}
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-gray-700 text-gray-400 text-xs">
        ♪
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-gray-200">{sample.name}</p>
        <p className="text-[10px] text-gray-500">
          {sample.genre ?? "—"} · {duration}
        </p>
      </div>
    </li>
  );
}
