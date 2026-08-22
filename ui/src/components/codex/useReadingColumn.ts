import { useCallback, useEffect, useRef, useState } from "react";
import {
  clampReadingColumn,
  effectiveReadingColumn,
  READING_COLUMN_DEFAULT,
  READING_COLUMN_STORAGE_KEY,
  readStoredReadingColumn,
  writeStoredReadingColumn,
} from "./reading-column";

export interface ReadingColumn {
  /** The width to render, clamped to what the pane can hold. */
  width: number;
  /** Attach to the pane whose width bounds the column. */
  paneRef: (element: HTMLElement | null) => void;
  setWidth(width: number): void;
  reset(): void;
  /** Begin a pointer drag from the splitter. */
  onDragStart(event: { clientX: number; preventDefault(): void }): void;
  dragging: boolean;
}

function storage() {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

/** The Folio reading column's width: an author preference held per device,
 * clamped on every render to the pane actually available, so a narrowed window
 * or a reopened rail can never leave the column overflowing. */
export function useReadingColumn(): ReadingColumn {
  const [preference, setPreference] = useState(() => {
    const store = storage();
    return (
      (store && readStoredReadingColumn(store, READING_COLUMN_STORAGE_KEY)) ??
      READING_COLUMN_DEFAULT
    );
  });
  const [available, setAvailable] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const paneElement = useRef<HTMLElement | null>(null);

  const paneRef = useCallback((element: HTMLElement | null) => {
    paneElement.current = element;
    setAvailable(element?.getBoundingClientRect().width ?? 0);
  }, []);

  useEffect(() => {
    const element = paneElement.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setAvailable(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const width = effectiveReadingColumn(preference, available);

  const setWidth = useCallback((next: number) => {
    const clamped = clampReadingColumn(next);
    setPreference(clamped);
    const store = storage();
    if (store) {
      writeStoredReadingColumn(store, READING_COLUMN_STORAGE_KEY, clamped);
    }
  }, []);

  const reset = useCallback(
    () => setWidth(READING_COLUMN_DEFAULT),
    [setWidth],
  );

  const onDragStart = useCallback(
    (event: { clientX: number; preventDefault(): void }) => {
      event.preventDefault();
      drag.current = { startX: event.clientX, startWidth: width };
      setDragging(true);
    },
    [width],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => {
      const start = drag.current;
      if (!start) return;
      // The column is centred, so it grows twice as fast as the pointer moves.
      setWidth(start.startWidth + (event.clientX - start.startX) * 2);
    };
    const onEnd = () => {
      setDragging(false);
      drag.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
  }, [dragging, setWidth]);

  return { width, paneRef, setWidth, reset, onDragStart, dragging };
}
