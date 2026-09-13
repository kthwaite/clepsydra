import { QueryClient } from "@tanstack/react-query";
import { isOfflineUncached } from "#/offline/swPolicy";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      throwOnError: true,
      // Vault mutations and the SSE `index_changed` stream (useVaultEvents)
      // drive freshness explicitly, so we don't need eager refetching. A short
      // staleTime collapses the remount/navigation refetch storm; window-focus
      // refetching is redundant given the event stream.
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // The service worker's offline_uncached 503 means the resource was
      // never synced to this device: retrying while still offline can never
      // succeed, so don't burn the default 3 retries on it. Individual
      // queries (e.g. usePage's 404 skip) may still set their own predicate,
      // which overrides this default.
      retry: (failureCount, error) =>
        !isOfflineUncached(error) && failureCount < 3,
    },
  },
});
