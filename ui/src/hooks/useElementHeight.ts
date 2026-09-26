import { useCallback, useEffect, useState } from "react";

/** An element's height: measured synchronously when it attaches, then
 *  re-measured `debounceMs` after resizing stops (a window drag fires the
 *  observer continuously; callers key queries on the result). */
export function useElementHeight<T extends HTMLElement>(
  debounceMs = 150,
): [(node: T | null) => void, number | null, () => void] {
  const [element, setElement] = useState<T | null>(null);
  const [height, setHeight] = useState<number | null>(null);

  const ref = useCallback((node: T | null) => {
    setElement(node);
    if (node) setHeight(node.getBoundingClientRect().height);
  }, []);

  /** Measure now, skipping the debounce (a known layout change). */
  const remeasure = useCallback(() => {
    if (element) setHeight(element.getBoundingClientRect().height);
  }, [element]);

  useEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(
        () => setHeight(element.getBoundingClientRect().height),
        debounceMs,
      );
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [element, debounceMs]);

  return [ref, height, remeasure];
}
