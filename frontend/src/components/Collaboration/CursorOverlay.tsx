import { useCollabStore } from "../../store/useCollabStore";

/**
 * Renders colored cursor dots with usernames for all remote collaborators.
 * Positioned as an absolute overlay on top of the ProjectWorkspace.
 */
export function CursorOverlay() {
  const remoteUsers = useCollabStore((s) => s.remoteUsers);

  const users = Object.values(remoteUsers).filter((u) => u.cursor !== null);

  if (users.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-50 overflow-hidden">
      {users.map((user) => (
        <div
          key={user.username}
          className="absolute"
          style={{
            left: user.cursor!.x,
            top: user.cursor!.y,
            transition: "left 0.05s linear, top 0.05s linear",
          }}
        >
          {/* Cursor dot */}
          <div
            className="h-3 w-3 rounded-full shadow-md"
            style={{ backgroundColor: user.color }}
          />
          {/* Username label */}
          <span
            className="ml-3 -mt-1 inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium text-white shadow"
            style={{ backgroundColor: user.color }}
          >
            {user.username}
          </span>
        </div>
      ))}
    </div>
  );
}
