import { useOnlineStatus } from "#/hooks/useOnlineStatus";
import { cn } from "#/lib/cn";
import {
  type ConnectionStatus,
  useConnectionStore,
} from "#/offline/connectionStore";
import { useOfflineStore } from "#/offline/offlineStore";

type IndicatorStatus = ConnectionStatus | "offline";

const DOT: Record<IndicatorStatus, string> = {
  connecting: "bg-faint animate-pulse",
  connected: "bg-accent",
  disconnected: "bg-hot",
  offline: "bg-faint",
};

export function offlineLabel(lastFullSync: string | null): string {
  if (!lastFullSync) return "Offline — no offline copy";
  const time = new Date(lastFullSync).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Offline — vault as of ${time}`;
}

function wordFor(status: IndicatorStatus, lastFullSync: string | null) {
  switch (status) {
    case "connecting":
      return "Connecting…";
    case "connected":
      return "Synced";
    case "disconnected":
      return "Disconnected";
    case "offline":
      if (!lastFullSync) return "Offline";
      return `Offline since ${new Date(lastFullSync).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}`;
  }
}

/** Footer sync state: a dot plus one word (spec decision 12). */
export function SyncIndicator() {
  const sse = useConnectionStore((s) => s.status);
  const online = useOnlineStatus();
  const lastFullSync = useOfflineStore((s) => s.lastFullSync);
  const status: IndicatorStatus = online ? sse : "offline";
  const title = status === "offline" ? offlineLabel(lastFullSync) : undefined;

  return (
    <span className="flex items-center gap-1.5" title={title}>
      <span
        aria-hidden
        className={cn("h-1.5 w-1.5 rounded-full", DOT[status])}
      />
      <span>{wordFor(status, lastFullSync)}</span>
    </span>
  );
}
