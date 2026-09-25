import { useCallback, useEffect, useRef, useState } from "react";
import { useFolioRails } from "#/store/folioRails";

type RailSide = "left" | "right";

type Options = {
  storageKey: string;
  side: RailSide;
  defaultWidth: number;
  min: number;
  max: number;
};

type Rail = {
  collapsed: boolean;
  toggle: () => void;
  setCollapsed: (v: boolean) => void;
  width: number;
  resizing: boolean;
  /** Attach to the drag handle (1px edge strip). */
  onResizeStart: (e: React.PointerEvent) => void;
};

function readNum(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n)) return n;
    }
  } catch {
    // ignore
  }
  return fallback;
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

/**
 * Collapsible + drag-resizable rail state, persisted to localStorage.
 * `side` controls which way the drag handle grows the rail.
 */
export function useCollapsibleRail({
  storageKey,
  side,
  defaultWidth,
  min,
  max,
}: Options): Rail {
  const wKey = `${storageKey}.w`;

  const [width, setWidth] = useState<number>(() => readNum(wKey, defaultWidth));
  const collapsed = useFolioRails(
    (s) => s.collapsed[storageKey] ?? s.isCollapsed(storageKey),
  );
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ startX: number; startW: number } | null>(null);

  const setCollapsed = useCallback(
    (v: boolean) => useFolioRails.getState().setCollapsed(storageKey, v),
    [storageKey],
  );

  const toggle = useCallback(
    () => useFolioRails.getState().toggle(storageKey),
    [storageKey],
  );

  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      drag.current = { startX: e.clientX, startW: width };
      setResizing(true);
      (e.target as Element).setPointerCapture?.(e.pointerId);
    },
    [width],
  );

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const next = side === "left" ? d.startW + dx : d.startW - dx;
      setWidth(Math.max(min, Math.min(max, Math.round(next))));
    };
    const onUp = () => {
      setResizing(false);
      drag.current = null;
      setWidth((w) => {
        write(wKey, String(w));
        return w;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [resizing, side, min, max, wKey]);

  return { collapsed, toggle, setCollapsed, width, resizing, onResizeStart };
}
