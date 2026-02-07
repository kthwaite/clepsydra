import {
  useVaultEvents,
  type ConnectionStatus,
} from "#/hooks/useVaultEvents";

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connecting: "Connecting\u2026",
  connected: "Live",
  disconnected: "Disconnected",
};

const STATUS_COLORS: Record<ConnectionStatus, string> = {
  connecting: "bg-muted-foreground",
  connected: "bg-foreground",
  disconnected: "bg-destructive",
};

export function SyncIndicator() {
  const status = useVaultEvents();

  return (
    <div
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      title={STATUS_LABELS[status]}
    >
      <div className={`h-1.5 w-1.5 ${STATUS_COLORS[status]}`} />
      <span className="sr-only">{STATUS_LABELS[status]}</span>
    </div>
  );
}
