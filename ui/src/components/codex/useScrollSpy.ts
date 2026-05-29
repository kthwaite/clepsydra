import { type RefObject, useCallback, useEffect, useState } from "react";

const HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6";

/**
 * Tracks the active heading within a scroll container for TOC scrollspy.
 * Heading DOM order matches the TOC entry order (both are document order), so
 * the returned index maps directly onto the TOC list. `recount` is a value to
 * re-run discovery on (e.g. the document revision).
 */
export function useScrollSpy(
  containerRef: RefObject<HTMLElement | null>,
  recount: unknown,
): { activeIndex: number; scrollTo: (index: number) => void } {
  const [activeIndex, setActiveIndex] = useState(0);

  const headings = useCallback((): HTMLElement[] => {
    const el = containerRef.current;
    if (!el) return [];
    return Array.from(el.querySelectorAll<HTMLElement>(HEADING_SELECTOR));
  }, [containerRef]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const compute = () => {
      const hs = headings();
      if (hs.length === 0) {
        setActiveIndex(0);
        return;
      }
      const top = el.getBoundingClientRect().top;
      const threshold = 96; // px below the container top counts as "current"
      let idx = 0;
      for (let i = 0; i < hs.length; i++) {
        const rel = hs[i].getBoundingClientRect().top - top;
        if (rel <= threshold) idx = i;
        else break;
      }
      setActiveIndex(idx);
    };

    compute();
    el.addEventListener("scroll", compute, { passive: true });
    window.addEventListener("resize", compute);
    return () => {
      el.removeEventListener("scroll", compute);
      window.removeEventListener("resize", compute);
    };
  }, [containerRef, headings, recount]);

  const scrollTo = useCallback(
    (index: number) => {
      const hs = headings();
      const target = hs[index];
      const el = containerRef.current;
      if (!target || !el) return;
      const top =
        target.getBoundingClientRect().top -
        el.getBoundingClientRect().top +
        el.scrollTop -
        16;
      el.scrollTo({ top, behavior: "smooth" });
    },
    [containerRef, headings],
  );

  return { activeIndex, scrollTo };
}
