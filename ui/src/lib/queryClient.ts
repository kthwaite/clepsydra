import { QueryClient } from "@tanstack/react-query";

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
    },
  },
});
