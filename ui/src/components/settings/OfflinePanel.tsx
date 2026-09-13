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
    <div className="border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider">
            Offline copy
          </h4>
          <p className="mt-1 text-sm text-muted-foreground">
            The whole vault is kept readable on this device without a
            connection.
          </p>
          <p className="mt-2 text-sm">{summary}</p>
          {running && (
            <p className="mt-1 text-sm text-muted-foreground">
              Syncing {progress.done} / {progress.total}
            </p>
          )}
          {lastError && (
            <p className="mt-1 text-sm text-destructive">
              Last sync: {lastError}
            </p>
          )}
        </div>
        <Button
          variant="secondary"
          size="sm"
          isDisabled={running}
          onPress={() => requestOfflineSyncNow()}
        >
          {running ? "Syncing…" : "Sync now"}
        </Button>
      </div>
    </div>
  );
}
