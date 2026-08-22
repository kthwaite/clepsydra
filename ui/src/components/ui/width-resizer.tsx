import type { KeyboardEvent, PointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "#/lib/cn";

export interface WidthResizerProps {
  /** Names what is being resized, e.g. "Resize the reading column". */
  label: string;
  /** The rendered width, already clamped to whatever bounds it. */
  width: number;
  min: number;
  max: number;
  step: number;
  onWidth(width: number): void;
  onReset(): void;
  onDragStart?(event: PointerEvent): void;
  className?: string;
}

/** A splitter that sets a width.
 *
 * Follows the ARIA focusable-separator pattern: the width *is* the separator's
 * value, so assistive technology announces every change without a live region
 * of its own. Used by the Folio reading column and by Base embeds; each owns
 * where its width is stored, this owns how it is changed. */
export function WidthResizer({
  label,
  width,
  min,
  max,
  step,
  onWidth,
  onReset,
  onDragStart,
  className,
}: WidthResizerProps) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      onWidth(width + step);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      onWidth(width - step);
    } else if (event.key === "Home") {
      event.preventDefault();
      onWidth(min);
    } else if (event.key === "End") {
      event.preventDefault();
      onWidth(max);
    }
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: <hr> can be neither focusable nor a drag handle — this is the ARIA APG focusable-separator (splitter) pattern, as in the board's column resize
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      tabIndex={0}
      title="Drag to resize. Arrow keys adjust it; double-click restores the default."
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      onPointerDown={onDragStart}
      className={cn(
        "absolute top-0 z-10 h-full w-[7px] -translate-x-1/2 cursor-col-resize outline-none hover:bg-[color-mix(in_oklab,var(--accent)_35%,transparent)] focus-visible:bg-[color-mix(in_oklab,var(--accent)_35%,transparent)]",
        className,
      )}
    />
  );
}

export interface WidthDragOptions {
  /** The width a drag starts from. */
  width: number;
  /** Called continuously while dragging. */
  onPreview(width: number): void;
  /** Called once, with the final width, when the pointer is released. */
  onCommit(width: number): void;
  /** Pointer travel to width travel. A centred element grows at twice the
   * pointer's speed, because both of its edges move. */
  scale?: number;
}

export interface WidthDrag {
  dragging: boolean;
  onDragStart(event: { clientX: number; preventDefault(): void }): void;
}

/** Pointer resizing that reports every move but writes once.
 *
 * A width held in the document must not add an undo entry per animation
 * frame, so the preview is transient and only the released width commits. */
export function useWidthDrag({
  width,
  onPreview,
  onCommit,
  scale = 2,
}: WidthDragOptions): WidthDrag {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const latest = useRef(width);
  const handlers = useRef({ onPreview, onCommit });
  handlers.current = { onPreview, onCommit };

  const onDragStart = useCallback(
    (event: { clientX: number; preventDefault(): void }) => {
      event.preventDefault();
      drag.current = { startX: event.clientX, startWidth: width };
      latest.current = width;
      setDragging(true);
    },
    [width],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent | globalThis.PointerEvent) => {
      const start = drag.current;
      if (!start) return;
      latest.current =
        start.startWidth + (event.clientX - start.startX) * scale;
      handlers.current.onPreview(latest.current);
    };
    const onEnd = () => {
      setDragging(false);
      drag.current = null;
      handlers.current.onCommit(latest.current);
    };
    window.addEventListener("pointermove", onMove as EventListener);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    return () => {
      window.removeEventListener("pointermove", onMove as EventListener);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
  }, [dragging, scale]);

  return { dragging, onDragStart };
}
