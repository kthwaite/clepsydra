import type { KeyboardEvent, PointerEvent } from "react";
import {
  READING_COLUMN_MAX,
  READING_COLUMN_MIN,
  READING_COLUMN_STEP,
} from "./reading-column";

interface ReadingColumnResizerProps {
  /** The rendered column width, already clamped to the pane. */
  width: number;
  onWidth(width: number): void;
  onReset(): void;
  /** Called with the pointer event that begins a drag. */
  onDragStart?(event: PointerEvent): void;
}

/** The splitter at the reading column's right edge. Follows the ARIA
 * focusable-separator pattern the board's column resize established: the
 * width is the separator's value, so assistive technology announces it on
 * every change without a live region of its own. */
export function ReadingColumnResizer({
  width,
  onWidth,
  onReset,
  onDragStart,
}: ReadingColumnResizerProps) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      onWidth(width + READING_COLUMN_STEP);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      onWidth(width - READING_COLUMN_STEP);
    } else if (event.key === "Home") {
      event.preventDefault();
      onWidth(READING_COLUMN_MIN);
    } else if (event.key === "End") {
      event.preventDefault();
      onWidth(READING_COLUMN_MAX);
    }
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: <hr> can be neither focusable nor a drag handle — this is the ARIA APG focusable-separator (splitter) pattern, as in the board's column resize
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the reading column"
      aria-valuemin={READING_COLUMN_MIN}
      aria-valuemax={READING_COLUMN_MAX}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      tabIndex={0}
      title="Drag to resize the reading column. Arrow keys adjust it; double-click restores the default."
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      onPointerDown={onDragStart}
      className="absolute top-0 z-10 h-full w-[7px] -translate-x-1/2 cursor-col-resize outline-none hover:bg-[color-mix(in_oklab,var(--accent)_35%,transparent)] focus-visible:bg-[color-mix(in_oklab,var(--accent)_35%,transparent)]"
    />
  );
}
