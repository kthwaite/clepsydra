import { Tick } from "#/components/codex/Tick";
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
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-10 md:py-12">
      <section className="flex flex-col rounded-2xl bg-sink px-6 pt-6 pb-7 md:px-8 md:pt-7 md:pb-[30px]">
        <span className="flex items-center gap-2.5">
          <Tick variant="faint" />
          <span className="font-serif text-[19px] italic text-mute">
            Offline
          </span>
        </span>
        <h1 className="mt-3 font-serif text-[36px] leading-[1.05] tracking-[-0.01em] text-ink md:text-[44px]">
          Not available offline
        </h1>
        <p className="mt-4 text-[17px] leading-[1.6] text-ink-2">
          This page hasn't been synced to this device yet.
        </p>
        <div className="mt-[22px] flex flex-wrap items-center gap-2.5">
          <Button
            onPress={onRetry}
            className="rounded-full bg-raise font-medium data-[hovered]:bg-raise/70 data-[pressed]:bg-raise/60"
          >
            Retry
          </Button>
        </div>
      </section>
    </div>
  );
}
