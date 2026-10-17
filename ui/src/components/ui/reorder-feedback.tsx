import { useCallback, useLayoutEffect, useRef, useState } from "react";

export type ReorderEdge = "left" | "right";

export function reorderEdgeShadow(
  edge: ReorderEdge | null,
): string | undefined {
  if (!edge) return undefined;
  return edge === "left"
    ? "inset 2px 0 0 0 var(--accent)"
    : "inset -2px 0 0 0 var(--accent)";
}

/** Restore after React has moved (or remounted) the control. Callers resolve
 * their own domain's focus target; this never owns or changes their ordering. */
export function useReorderFeedback() {
  const [announcement, setAnnouncement] = useState({
    message: "",
    revision: 0,
  });
  const focusTarget = useRef<(() => HTMLElement | null) | undefined>(undefined);
  const report = useCallback(
    (message: string, focus?: () => HTMLElement | null) => {
      focusTarget.current = focus;
      setAnnouncement((previous) => ({
        message,
        revision: previous.revision + 1,
      }));
    },
    [],
  );

  useLayoutEffect(() => {
    const resolve = focusTarget.current;
    focusTarget.current = undefined;
    const element = resolve?.();
    if (
      element?.isConnected &&
      element.ownerDocument.activeElement !== element
    ) {
      element.focus();
    }
  });

  return { announcement, report };
}

export function ReorderAnnouncement({
  announcement,
  role,
}: {
  announcement: { message: string; revision: number };
  role?: "status";
}) {
  return (
    <div role={role} aria-live="polite" aria-atomic="true" className="sr-only">
      <span key={announcement.revision}>{announcement.message}</span>
    </div>
  );
}
