import { Button } from "#/components/ui/button";

/**
 * Shown wherever a query settles on the service worker's `offline_uncached`
 * 503 (see `#/offline/swPolicy`): the requested resource was never synced to
 * this device, so retrying offline can never succeed. Shared by `RouteError`
 * (a route-level throw) and `Folio` (a page-detail query that opts out of
 * `throwOnError` and surfaces the same shape as query `error` state instead).
 */
export function OfflineUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mx-auto max-w-3xl px-8 py-6">
      <section className="border border-border bg-background p-5 shadow-md">
        <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
          Offline
        </p>
        <h1 className="mt-2 font-heading text-2xl font-bold">
          Not available offline
        </h1>
        <p className="mt-2 text-sm">
          This page hasn't been synced to this device yet.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onPress={onRetry}>
            Retry
          </Button>
        </div>
      </section>
    </div>
  );
}
