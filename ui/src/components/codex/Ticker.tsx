import { useEffect, useState } from "react";
import { useStats } from "#/api/index";
import { useVaultEvents } from "#/hooks/useVaultEvents";

const APP_START = Date.now();

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function useUtcClock(): string {
  const [t, setT] = useState(() => fmtUtc(new Date()));
  useEffect(() => {
    const id = window.setInterval(() => setT(fmtUtc(new Date())), 1000);
    return () => window.clearInterval(id);
  }, []);
  return t;
}

function fmtUtc(d: Date): string {
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function useUptime(): string {
  const [s, setS] = useState(() => Math.floor((Date.now() - APP_START) / 1000));
  useEffect(() => {
    const id = window.setInterval(
      () => setS(Math.floor((Date.now() - APP_START) / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, []);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${pad(m)}m`;
}

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
  const utc = useUtcClock();
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
      <span className="flex flex-shrink-0 items-center gap-1.5 px-3 py-[3px]">
        <span className="text-[9px] uppercase tracking-[0.16em] text-ink-mute">
          utc
        </span>
        <span className="text-ink">{utc}</span>
      </span>
    </div>
  );
}
