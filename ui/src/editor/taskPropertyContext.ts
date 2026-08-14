import { createContext, useContext } from "react";
import type { Path } from "slate";

/**
 * Opener contract for the task-property popover. Rendered chips only request
 * the popover; the controller that owns its state lives at editor level.
 * The anchor is resolved by the caller at click time (never cached) so the
 * popover positions against the DOM node that actually exists right now.
 */
export interface TaskPropertyPopoverController {
  openForPath(path: Path, anchor: HTMLElement): void;
}

const TaskPropertyPopoverContext =
  createContext<TaskPropertyPopoverController | null>(null);

export const TaskPropertyPopoverProvider = TaskPropertyPopoverContext.Provider;

/** Null when no controller is mounted — chips then render but do nothing. */
export function useTaskPropertyPopover(): TaskPropertyPopoverController | null {
  return useContext(TaskPropertyPopoverContext);
}
