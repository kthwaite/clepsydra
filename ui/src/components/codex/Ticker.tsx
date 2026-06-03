import { useStats } from "#/api/index";
import { useUptime } from "#/hooks/useUptime";
import { useVaultEvents } from "#/hooks/useVaultEvents";

const SYNC: Record<string, { label: string; color: string }> = {
  connected: { label: "NOMINAL", color: "var(--cool)" },
  connecting: { label: "SYNCING", color: "var(--warn)" },
  disconnected: { label: "OFFLINE", color: "var(--hot)" },
};

function Cell({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="flex flex-shrink-0 items-center gap-1.5 border-r border-rule-soft px-3 py-[3px]">
      <span className="text-[9px] uppercase tracking-[0.16em] text-ink-mute">
        {label}
      </span>
      <span className="text-ink-2">{value}</span>
    </span>
  );
}

/**
 * Slim, real-data telemetry strip. Rendered as a shell rail when diegetic
 * chrome is enabled. Every value is real corpus data — no fabricated telemetry.
 */
export function Ticker() {
  const { data: stats } = useStats();
  const sync = useVaultEvents();
  const uptime = useUptime();
  const link = SYNC[sync] ?? SYNC.disconnected;

  return (
    <div className="cl-mono cl-noscroll flex flex-shrink-0 items-stretch overflow-x-auto border-b border-rule bg-paper-2 text-[10px] tabular-nums">
      <span className="flex flex-shrink-0 items-center gap-1.5 border-r border-rule-soft px-3 py-[3px]">
        <span
          className="inline-block h-[6px] w-[6px]"
          style={{ background: link.color }}
        />
        <span className="text-[9px] uppercase tracking-[0.16em] text-ink-mute">
          link
        </span>
        <span className="text-ink-2">{link.label}</span>
      </span>
      <Cell label="notes" value={stats?.pages ?? "—"} />
      <Cell label="links" value={stats?.links_total ?? "—"} />
      <Cell label="tags" value={stats?.tags ?? "—"} />
      <Cell label="unresolved" value={stats?.links_unresolved ?? "—"} />
      <Cell label="orphans" value={stats?.orphan_pages ?? "—"} />
      <Cell label="attach" value={stats?.attachments ?? "—"} />
      <span className="flex-1" />
      <Cell label="uptime" value={uptime} />
    </div>
  );
}
