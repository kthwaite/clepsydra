import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";

/**
 * Re-firing a `contextmenu` event on another element lets one React Aria
 * `MenuTrigger trigger="contextMenu"` serve a whole region: the trigger's own
 * handler reads the point off the event, so the menu still opens where the
 * reader asked for it. Nothing in the region has to be focusable, which is
 * what keeps React Aria's in-cell focus on the cell's real control.
 */

/** Viewport point at which a forwarded context menu should open. */
export interface ContextMenuPoint {
  clientX: number;
  clientY: number;
}

/** React Aria's own platform test, so the two agree on what "mac" means. */
function isMacPlatform(): boolean {
  const agent = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  return /^Mac/i.test(agent.userAgentData?.platform ?? navigator.platform);
}

/** Under the element, the way a browser anchors a keyboard-summoned menu. */
export function pointUnder(element: Element): ContextMenuPoint {
  const rect = element.getBoundingClientRect();
  return { clientX: rect.left, clientY: rect.bottom };
}

/** The pointer's position, or under the target when a key summoned it. */
export function pointOfContextMenu(
  event: ReactMouseEvent<HTMLElement>,
): ContextMenuPoint {
  if (event.clientX !== 0 || event.clientY !== 0)
    return { clientX: event.clientX, clientY: event.clientY };
  return pointUnder(event.target as Element);
}

/** The keys a browser turns into a `contextmenu` event. */
export function isContextMenuKey(
  event: ReactKeyboardEvent<HTMLElement>,
): boolean {
  if (event.key === "ContextMenu") return true;
  if (event.key === "F10" && event.shiftKey) return true;
  // Ctrl+Enter is macOS's shortcut; some browsers do not fire `contextmenu`
  // for it, so React Aria carries the same fallback on its own triggers.
  return event.key === "Enter" && event.ctrlKey && isMacPlatform();
}

/** Opens `trigger`'s context menu at `point`. */
export function forwardContextMenu(
  trigger: HTMLElement | null,
  point: ContextMenuPoint,
): void {
  trigger?.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      ...point,
    }),
  );
}
