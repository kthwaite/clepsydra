/** Shared constants and micro-chips for the Tasking board. */

import type { BoardOperation } from "#/api/board";
import { formatDayMonth } from "#/lib/time";
import type { BoardMode } from "#/store/board";

// ── date formatting ──────────────────────────────────────────────────────────

/**
 * Formats a cycle date window as "21 Sep – 4 Oct", or "14–27 Sep" within one
 * month; "From …" / "Until …" when only one bound is set; "No dates" when
 * neither is.
 */
export function fmtCycleWindow(
  start?: string | null,
  end?: string | null,
): string {
  if (start && end) {
    const [from, to] = [formatDayMonth(start), formatDayMonth(end)];
    const sameMonth = from !== start && start.slice(0, 7) === end.slice(0, 7);
    // Same month: "14–27 Sep".
    return sameMonth ? `${from.split(" ")[0]}–${to}` : `${from} – ${to}`;
  }
  if (start) return `From ${formatDayMonth(start)}`;
  if (end) return `Until ${formatDayMonth(end)}`;
  return "No dates";
}

// ── canonical op key ─────────────────────────────────────────────────────────

/**
 * Canonical opFilter key for an operation: its project slug when one exists,
 * else its code (covers board:true PROJECT pages with no project: frontmatter).
 * Used consistently by ScopeRail row clicks/active checks and the
 * TaskingScreen activeOp lookup so selection state never diverges.
 */
export const opKey = (op: BoardOperation): string => op.project ?? op.code;

// ── column / priority ordering ───────────────────────────────────────────────

export const COL_ORDER = [
  "INTAKE",
  "TRIAGE",
  "FIELD",
  "REVIEW",
  "SEALED",
] as const;

export const COL_LABEL: Record<string, string> = {
  INTAKE: "Inbox",
  TRIAGE: "Ready",
  FIELD: "In Progress",
  REVIEW: "Review",
  SEALED: "Done",
};

export const COL_SUBLABEL: Record<string, string> = {
  INTAKE: "Unassessed",
  TRIAGE: "Ready to start",
  FIELD: "Being worked on",
  REVIEW: "Awaiting review",
  SEALED: "Completed",
};

export const PRI_ORDER = ["P0", "P1", "P2", "P3"] as const;

export const PRI_LABEL: Record<string, string> = {
  P0: "Critical",
  P1: "High",
  P2: "Medium",
  P3: "Low",
};

export const CYCLE_STATE_LABEL: Record<string, string> = {
  PLANNED: "Planned",
  ACTIVE: "Active",
  CLOSED: "Closed",
  BACKLOG: "Backlog",
};

/** Resolves a persisted cycle state id to its display label. */
export function cycleStateLabel(state: string): string {
  return CYCLE_STATE_LABEL[state] ?? state;
}

/**
 * Single-sourced priority color map: bar (on-state fill) and text (badge
 * foreground / off-state outline) per priority. Stone & Lamp ranks by tone:
 * Critical hot, High ink, Medium mute, Low faint (bar) / mute (label).
 */
export const PRI_COLOR: Record<string, { bar: string; text: string }> = {
  P0: { bar: "var(--hot)", text: "var(--hot)" },
  P1: { bar: "var(--ink)", text: "var(--ink)" },
  P2: { bar: "var(--mute)", text: "var(--mute)" },
  // Low's label stays mute: faint text is illegible on raise cards.
  P3: { bar: "var(--faint)", text: "var(--mute)" },
};

/** Looks up a priority's color pair, falling back to a neutral default. */
export function priColor(pri: string): { bar: string; text: string } {
  return PRI_COLOR[pri] ?? { bar: "var(--mute)", text: "var(--mute)" };
}
/** Resolves a persisted Task status id to its fixed display label. */
export function taskStatusLabel(status: string): string {
  return COL_LABEL[status] ?? status;
}

/** Resolves a persisted board status id to its fixed display label. */
export type ColLabelFn = (id: string) => string;

// ── mode descriptor ──────────────────────────────────────────────────────────

export const MODES = [
  { id: "card", label: "Board", gl: "cards" },
  { id: "backlog", label: "List", gl: "rows" },
  { id: "cycle", label: "Cycles", gl: "sprint" },
  { id: "timeline", label: "Timeline", gl: "tl" },
] as const satisfies { id: BoardMode; label: string; gl: string }[];

// ── health color helper ──────────────────────────────────────────────────────

/**
 * Returns the CSS color variable for a health status.
 * GREEN → var(--cool), AMBER → var(--warn), RED → var(--hot), else → var(--mute).
 */
export function healthColor(health: string): string {
  if (health === "GREEN") return "var(--cool)";
  if (health === "AMBER") return "var(--warn)";
  if (health === "RED") return "var(--hot)";
  return "var(--mute)";
}

// ── micro-chip components ────────────────────────────────────────────────────

/** Priority as a tinted pill: P0 hot, P1 ink, P2 mute, P3 faint. */
export function PriChip({ pri }: { pri: string }) {
  const { text: color } = priColor(pri);
  return (
    <span
      className="inline-block rounded-full bg-sink px-2 text-[12px] leading-5 tabular-nums"
      style={{ color }}
    >
      {pri}
    </span>
  );
}

/** Status colour per board column: Inbox and Done faint, Ready ink-2,
 *  In Progress cobalt, Review hot. */
export function statusColor(col: string): string {
  if (col === "FIELD") return "var(--accent)";
  if (col === "REVIEW") return "var(--hot)";
  if (col === "TRIAGE") return "var(--ink-2)";
  return "var(--faint)";
}

/** 6px round status pip coloured by board column. */
export function StatePip({ col }: { col: string }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full"
      style={{ background: statusColor(col) }}
    />
  );
}

/** 7px round health dot: GREEN cobalt, AMBER/RED hot (RED pulses), else mute. */
export function HealthDot({ health }: { health: string }) {
  const color = healthColor(health);
  return (
    <span
      className={`inline-block h-[7px] w-[7px] flex-shrink-0 rounded-full${health === "RED" ? " animate-pulse" : ""}`}
      style={{ background: color }}
    />
  );
}

/** Hot "Hold" pill. */
export function HoldTag() {
  return (
    <span className="inline-block rounded-full bg-[color-mix(in_oklab,var(--hot)_12%,transparent)] px-2 text-[12px] leading-5 text-hot">
      Hold
    </span>
  );
}

/**
 * 7px round cycle state pip.
 * PLANNED → hollow ring, ACTIVE → cobalt + pulse, CLOSED → faint, BACKLOG → hot.
 */
export function CycleStatePip({ state }: { state: string }) {
  if (state === "PLANNED") {
    return (
      <span className="inline-block h-[7px] w-[7px] flex-shrink-0 rounded-full shadow-[inset_0_0_0_1px_var(--mute)]" />
    );
  }
  const color =
    state === "ACTIVE"
      ? "var(--accent)"
      : state === "CLOSED"
        ? "var(--faint)"
        : state === "BACKLOG"
          ? "var(--hot)"
          : "var(--mute)";
  return (
    <span
      className={`inline-block h-[7px] w-[7px] flex-shrink-0 rounded-full${state === "ACTIVE" ? " animate-pulse" : ""}`}
      style={{ background: color }}
    />
  );
}
