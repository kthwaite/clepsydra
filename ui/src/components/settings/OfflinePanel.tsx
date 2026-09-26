import { Section } from "#/components/codex/Section";
import { Button } from "#/components/ui/button";
import { formatRelativeTime } from "#/lib/time";
import { useOfflineStore } from "#/offline/offlineStore";
import { requestOfflineSyncNow } from "#/offline/useOfflineSync";

export function OfflinePanel() {
  const phase = useOfflineStore((s) => s.phase);
  const progress = useOfflineStore((s) => s.progress);
  const lastFullSync = useOfflineStore((s) => s.lastFullSync);
  const pageCount = useOfflineStore((s) => s.pageCount);
  const lastError = useOfflineStore((s) => s.lastError);
  const running = phase === "running";

  const summary = lastFullSync
    ? `${pageCount} pages, synced ${formatRelativeTime(lastFullSync)}`
    : "No offline copy yet.";

  return (
    <Section label="Offline copy" compact headingLevel={4} className="[&_h4]:text-[21px]">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 max-w-2xl flex-1 basis-64">
          <p className="text-[14px] text-mute">
            The whole vault is kept readable on this device without a
            connection.
          </p>
          <p className="mt-2 text-[14px] text-ink tabular-nums">{summary}</p>
          {running && (
            <p className="mt-1 text-[14px] text-mute tabular-nums">
              Syncing {progress.done} / {progress.total}
            </p>
          )}
          {lastError && (
            <p className="mt-1 text-[14px] text-hot">Last sync: {lastError}</p>
          )}
        </div>
        <Button
          variant="secondary"
          isDisabled={running}
          onPress={() => requestOfflineSyncNow()}
        >
          {running ? "Syncing…" : "Sync now"}
        </Button>
      </div>
    </Section>
  );
}
