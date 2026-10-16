import { type MouseEvent, useContext, useEffect, useRef } from "react";
import {
  PreviewContext,
  PreviewRestrictionsContext,
} from "#/components/codex/PreviewContext";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import type { PreviewTarget } from "#/lib/previewTarget";
import { usePreviewStore } from "#/store/preview";

const HOVER_DELAY = 220;

export function isModifiedLinkActivation(event: MouseEvent) {
  return (
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    event.button !== 0
  );
}

/** Resolution is read-only and owned by the caller; this hook owns the gesture. */
export function usePreviewTrigger(
  target?: PreviewTarget,
  resolveTarget?: () => Promise<PreviewTarget | null>,
) {
  const parentId = useContext(PreviewContext);
  const restricted = useContext(PreviewRestrictionsContext);
  const triggerRef = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const opened = useRef<string | undefined>(undefined);
  const hovered = useRef(false);
  const focused = useRef(false);
  const mounted = useRef(true);
  const resolving = useRef(false);

  const cancelDelay = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      if (opened.current) {
        usePreviewStore.getState().leave(opened.current);
        usePreviewStore.getState().focusWithin(opened.current, false);
      }
    };
  }, []);

  const open = async (mode: "peek" | "reader", opener?: HTMLElement) => {
    cancelDelay();
    const element = opener ?? triggerRef.current;
    if (!element || resolving.current) return;
    resolving.current = true;
    try {
      const resolved = target ?? (await resolveTarget?.());
      if (
        !resolved ||
        !mounted.current ||
        (mode === "peek" && !hovered.current)
      )
        return;
      const store = usePreviewStore.getState();
      const id = store.open(resolved, element.getBoundingClientRect(), {
        mode,
        parentId,
        opener: element,
        restricted,
      });
      opened.current = id;
      if (hovered.current) store.enter(id);
      if (focused.current) store.focusWithin(id, true);
    } finally {
      resolving.current = false;
    }
  };

  return {
    parentId,
    triggerRef,
    openReader: (opener?: HTMLElement) => open("reader", opener),
    onMouseEnter: () => {
      hovered.current = true;
      if (opened.current) usePreviewStore.getState().enter(opened.current);
      cancelDelay();
      // Only resolved links hover-open; explicit activation can resolve a miss.
      if (target)
        timer.current = setTimeout(() => {
          void open("peek");
        }, HOVER_DELAY);
    },
    onMouseLeave: () => {
      hovered.current = false;
      cancelDelay();
      if (opened.current) usePreviewStore.getState().leave(opened.current);
    },
    onFocus: () => {
      focused.current = true;
      if (opened.current)
        usePreviewStore.getState().focusWithin(opened.current, true);
    },
    onBlur: () => {
      focused.current = false;
      if (opened.current)
        usePreviewStore.getState().focusWithin(opened.current, false);
    },
  };
}

export function PreviewAction({
  onOpen,
}: {
  onOpen: (opener: HTMLElement) => void;
}) {
  return (
    <button
      type="button"
      aria-label="Preview"
      className={cn(
        "pointer-events-auto ml-1 inline-flex rounded px-1 text-[12px] font-sans not-italic text-mute hover:bg-sink hover:text-ink [@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/preview:opacity-100 group-focus-within/preview:opacity-100 focus:opacity-100",
        FOCUS_RING_NATIVE,
      )}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen(event.currentTarget);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}
    >
      Preview
    </button>
  );
}
