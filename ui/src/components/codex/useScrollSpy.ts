import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  activeIndexAt,
  computeTriggers,
  jumpTargetFor,
} from "#/components/codex/scrollTriggers";

const HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6";

interface TriggerMap {
  headingTops: number[];
  triggers: number[];
  maxScroll: number;
}

const EMPTY_MAP: TriggerMap = { headingTops: [], triggers: [], maxScroll: 0 };

/**
 * Tracks the active heading within a scroll container for TOC scrollspy.
 * Heading DOM order matches the TOC entry order (both are document order), so
 * the returned index maps directly onto the TOC list. `recount` re-runs
 * discovery for content changes, and `reattach` tracks container replacement.
 *
 * Activation positions come from the shared trigger map in `scrollTriggers`,
 * which uplifts otherwise-unreachable triggers near the document end onto the
 * scrollable range and drives `scrollTo` from the same map — so every TOC
 * entry is reachable and the clicked entry is always the one highlighted.
 */
export function useScrollSpy(
  containerRef: RefObject<HTMLElement | null>,
  recount: unknown,
  reattach?: unknown,
): { activeIndex: number; scrollTo: (index: number) => void } {
  const [activeIndex, setActiveIndex] = useState(0);
  const mapRef = useRef<TriggerMap>(EMPTY_MAP);

  const remap = useCallback(() => {
    const el = containerRef.current;
    if (!el) {
      mapRef.current = EMPTY_MAP;
      return;
    }
    const editor = el.querySelector<HTMLElement>("[data-slate-editor]");
    const hs = Array.from(
      editor?.querySelectorAll<HTMLElement>(HEADING_SELECTOR) ?? [],
    );
    const containerTop = el.getBoundingClientRect().top;
    const headingTops = hs.map(
      (h) => h.getBoundingClientRect().top - containerTop + el.scrollTop,
    );
    const maxScroll = el.scrollHeight - el.clientHeight;
    mapRef.current = {
      headingTops,
      triggers: computeTriggers(headingTops, maxScroll),
      maxScroll,
    };
  }, [containerRef]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const compute = () => {
      // content can reflow without firing resize (e.g. images loading);
      // refresh the map whenever the scrollable range has drifted
      if (el.scrollHeight - el.clientHeight !== mapRef.current.maxScroll) {
        remap();
      }
      const { triggers, maxScroll } = mapRef.current;
      setActiveIndex(activeIndexAt(el.scrollTop, triggers, maxScroll));
    };
    const refresh = () => {
      remap();
      compute();
    };

    refresh();
    el.addEventListener("scroll", compute, { passive: true });
    window.addEventListener("resize", refresh);
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(refresh)
        : undefined;
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", compute);
      window.removeEventListener("resize", refresh);
      observer?.disconnect();
    };
  }, [containerRef, remap, recount, reattach]);

  const scrollTo = useCallback(
    (index: number) => {
      const el = containerRef.current;
      if (!el) return;
      remap();
      const { headingTops, triggers, maxScroll } = mapRef.current;
      if (index < 0 || index >= headingTops.length) return;
      el.scrollTo({
        top: jumpTargetFor(index, headingTops, triggers, maxScroll),
        behavior: "smooth",
      });
    },
    [containerRef, remap],
  );

  return { activeIndex, scrollTo };
}
