// Pure positioning + gating logic for the Sheaf tab hover preview. No React,
// no I/O — testable in isolation.

const MARGIN = 8;

/**
 * Horizontal position for a preview card of width `width`, anchored at a tab's
 * left edge but clamped so it never overflows the viewport. Mirrors the clamp
 * used by the floating link-preview window (store/preview.ts).
 */
export function clampPreviewLeft(
  rectLeft: number,
  viewportWidth: number,
  width: number,
): number {
  return Math.min(Math.max(MARGIN, rectLeft), viewportWidth - width - MARGIN);
}

/**
 * Whether hovering a tab should open a preview: it needs a real path, and the
 * active tab is exempt only while its page is the one on screen. Off Folio —
 * Tasking, Gazetteer — no tab's page is rendered, so the active tab previews
 * like any other (`activeTabVisible: false`).
 */
export function shouldPreviewTab(
  path: string | undefined,
  tabId: string,
  activeTabId: string | null,
  activeTabVisible: boolean,
): boolean {
  return !!path && (!activeTabVisible || tabId !== activeTabId);
}
