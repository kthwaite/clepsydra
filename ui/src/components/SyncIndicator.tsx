import { useOnlineStatus } from "#/hooks/useOnlineStatus";
import { cn } from "#/lib/cn";
import {
  type ConnectionStatus,
  useConnectionStore,
} from "#/offline/connectionStore";
import { useOfflineStore } from "#/offline/offlineStore";

type IndicatorStatus = ConnectionStatus | "offline";

const STATUS_COLORS: Record<IndicatorStatus, string> = {
  connecting: "bg-muted-foreground",
  connected: "bg-foreground",
  disconnected: "bg-destructive",
  offline: "bg-muted-foreground",
};

export function offlineLabel(lastFullSync: string | null): string {
  if (!lastFullSync) return "Offline — no offline copy";
  const time = new Date(lastFullSync).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Offline — vault as of ${time}`;
}

function labelFor(status: IndicatorStatus, lastFullSync: string | null) {
  switch (status) {
    case "connecting":
      return "Connecting…";
    case "connected":
      return "Live";
    case "disconnected":
      return "Disconnected";
    case "offline":
      return offlineLabel(lastFullSync);
  }
}

export function SyncIndicator() {
  const sse = useConnectionStore((s) => s.status);
  const online = useOnlineStatus();
  const lastFullSync = useOfflineStore((s) => s.lastFullSync);
  const status: IndicatorStatus = online ? sse : "offline";
  const label = labelFor(status, lastFullSync);

  return (
    <div
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      title={label}
    >
      <div className={cn("h-1.5 w-1.5", STATUS_COLORS[status])} />
      <span className="sr-only">{label}</span>
    </div>
  );
}
