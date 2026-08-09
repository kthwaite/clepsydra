import { useSyncExternalStore } from "react";

export const MOBILE_LAYOUT_QUERY = "(max-width: 1199px)";

function media(): MediaQueryList | undefined {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(MOBILE_LAYOUT_QUERY)
    : undefined;
}

export function useMobileLayout(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = media();
      query?.addEventListener("change", notify);
      return () => query?.removeEventListener("change", notify);
    },
    () => media()?.matches ?? false,
    () => false,
  );
}
