import { useCallback, useSyncExternalStore } from "react";

function media(query: string): MediaQueryList | undefined {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(query)
    : undefined;
}

/** Whether `query` matches now; re-renders when that changes. False without
 *  matchMedia. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      const list = media(query);
      list?.addEventListener("change", notify);
      return () => list?.removeEventListener("change", notify);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => media(query)?.matches ?? false,
    () => false,
  );
}
