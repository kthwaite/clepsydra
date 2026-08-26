/** Shared constants and micro-chips for the Tasking board. */

import type { BoardOperation } from "#/api/board";
import type { BoardMode } from "#/store/board";

// ── date formatting ──────────────────────────────────────────────────────────

/**
 * Formats a cycle date window as "MM.DD — MM.DD" (half-open when only one
 * bound is set). Returns "No dates" when both start and end are absent.
 */
export function fmtCycleWindow(
  start?: string | null,
  end?: string | null,
): string {
  if (!start && !end) return "No dates";
  const fmt = (s: string) => {
    // ISO date "YYYY-MM-DD" → "MM.DD"
    const parts = s.split("-");
    if (parts.length === 3) return `${parts[1]}.${parts[2]}`;
    return s;
  };
  if (start && end) return `${fmt(start)} — ${fmt(end)}`;
  if (start) return `${fmt(start)} —`;
  if (!end) return "No dates";
  return `— ${fmt(end)}`;
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
 * Single-sourced priority color map: bar (left rail / on-state fill) and
 * text (badge foreground / off-state outline) per priority.
 */
export const PRI_COLOR: Record<string, { bar: string; text: string }> = {
  P0: { bar: "var(--hot)", text: "var(--hot)" },
  P1: { bar: "var(--warn)", text: "var(--warn)" },
  P2: { bar: "var(--cool)", text: "var(--cool)" },
  P3: { bar: "var(--ink-4)", text: "var(--ink-mute)" },
};

/** Looks up a priority's color pair, falling back to a neutral default. */
export function priColor(pri: string): { bar: string; text: string } {
  return PRI_COLOR[pri] ?? { bar: "var(--ink-3)", text: "var(--ink-mute)" };
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
 * GREEN → var(--cool), AMBER → var(--warn), RED → var(--hot), else → var(--ink-mute).
 */
export function healthColor(health: string): string {
  if (health === "GREEN") return "var(--cool)";
  if (health === "AMBER") return "var(--warn)";
  if (health === "RED") return "var(--hot)";
  return "var(--ink-mute)";
}

// ── micro-chip components ────────────────────────────────────────────────────

/** Small coloured priority badge: P0=hot P1=warn P2=cool P3=ink-mute */
export function PriChip({ pri }: { pri: string }) {
  const { text: color } = priColor(pri);
  return (
    <span
      className="inline-block border px-[4px] text-[9px] font-medium leading-[14px] tracking-[0.08em]"
      style={{ color, borderColor: color }}
    >
      {pri}
    </span>
  );
}

/**
 * 6×6 square pip coloured by board status column.
 * Colors from .bk-statepip.* in styles-board.css, in Vessel tokens:
 *   INTAKE  → ink-faint (default/empty)
 *   TRIAGE  → ink-2
 *   FIELD   → cool (cyan)
 *   REVIEW  → warn (amber)
 *   SEALED  → ink-faint (very muted)
 */
export function StatePip({ col }: { col: string }) {
  const color =
    col === "FIELD"
      ? "var(--cool)"
      : col === "REVIEW"
        ? "var(--warn)"
        : col === "SEALED"
          ? "var(--ink-faint)"
          : col === "TRIAGE"
            ? "var(--ink-2)"
            : "var(--ink-faint)"; // INTAKE default
  return (
    <span
      className="inline-block h-[6px] w-[6px] flex-shrink-0"
      style={{ background: color }}
    />
  );
}

/**
 * 7×7 health dot: GREEN=cool, AMBER=warn, RED=hot (blinking), else ink-mute.
 * Matches .op-dot in styles-board.css.
 */
export function HealthDot({ health }: { health: string }) {
  const color = healthColor(health);
  return (
    <span
      className={`inline-block h-[7px] w-[7px] flex-shrink-0${health === "RED" ? " animate-pulse" : ""}`}
      style={{ background: color }}
    />
  );
}

/** Inline HOT-bordered "HOLD" chip (matches .hold-tag in styles-board.css). */
export function HoldTag() {
  return (
    <span
      className="inline-block border border-[var(--hot)] px-[4px] text-[var(--fs-xs)] leading-[14px] tracking-[0.12em]"
      style={{ color: "var(--hot)" }}
    >
      HOLD
    </span>
  );
}

/**
 * 7×7 cycle state pip.
 * PLANNED → transparent box, ACTIVE → cool + blink, CLOSED → ink-faint, BACKLOG → warn
 * Matches .bl-sp-pip.* in styles-board.css.
 */
export function CycleStatePip({ state }: { state: string }) {
  if (state === "PLANNED") {
    return (
      <span
        className="inline-block h-[7px] w-[7px] flex-shrink-0 border border-[var(--ink-mute)]"
        style={{ background: "transparent" }}
      />
    );
  }
  const color =
    state === "ACTIVE"
      ? "var(--cool)"
      : state === "CLOSED"
        ? "var(--ink-faint)"
        : state === "BACKLOG"
          ? "var(--warn)"
          : "var(--ink-mute)";
  return (
    <span
      className={`inline-block h-[7px] w-[7px] flex-shrink-0${state === "ACTIVE" ? " animate-pulse" : ""}`}
      style={{ background: color }}
    />
  );
}
