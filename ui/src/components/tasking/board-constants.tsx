/** Shared constants and micro-chips for the Tasking board. */

// ── column / priority ordering ───────────────────────────────────────────────

export const COL_ORDER = [
  "INTAKE",
  "TRIAGE",
  "FIELD",
  "REVIEW",
  "SEALED",
] as const;

export const COL_LABEL: Record<string, string> = {
  INTAKE: "INTAKE",
  TRIAGE: "TRIAGE",
  FIELD: "IN-FIELD",
  REVIEW: "REVIEW",
  SEALED: "SEALED",
};

export const PRI_ORDER = ["P0", "P1", "P2", "P3"] as const;

export const PRI_LABEL: Record<string, string> = {
  P0: "CRITICAL",
  P1: "HIGH",
  P2: "NORMAL",
  P3: "LOW",
};

// ── mode descriptor ──────────────────────────────────────────────────────────

export const MODES = [
  { id: "card", label: "CARD", gl: "cards" },
  { id: "backlog", label: "BACKLOG", gl: "rows" },
  { id: "cycle", label: "CYCLE", gl: "sprint" },
  { id: "timeline", label: "TIMELINE", gl: "tl" },
] as const;

export type ModeId = (typeof MODES)[number]["id"];

// ── micro-chip components ────────────────────────────────────────────────────

/** Small coloured priority badge: P0=hot P1=warn P2=cool P3=ink-mute */
export function PriChip({ pri }: { pri: string }) {
  const color =
    pri === "P0"
      ? "var(--hot)"
      : pri === "P1"
        ? "var(--warn)"
        : pri === "P2"
          ? "var(--cool)"
          : "var(--ink-mute)";
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
 * Colors from .bk-statepip.* in styles-board.css:
 *   INTAKE  → ink-faint (default/empty)
 *   TRIAGE  → ink-2
 *   FIELD   → cool (cyan)
 *   REVIEW  → warn (amber)
 *   SEALED  → ink-4 (very muted)
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
 * 7×7 health dot: GREEN=cool, AMBER=warn, RED=hot (blinking), else ink-3.
 * Matches .op-dot in styles-board.css.
 */
export function HealthDot({ health }: { health: string }) {
  const color =
    health === "GREEN"
      ? "var(--cool)"
      : health === "AMBER"
        ? "var(--warn)"
        : health === "RED"
          ? "var(--hot)"
          : "var(--ink-mute)";
  return (
    <span
      className={`inline-block h-[7px] w-[7px] flex-shrink-0${health === "RED" ? " animate-pulse" : ""}`}
      style={{ background: color }}
    />
  );
}

/** Rotated HOT-bordered "HOLD" stamp for task cards. */
export function HoldTag() {
  return (
    <span
      className="inline-block border border-[var(--hot)] px-[4px] text-[9px] leading-[14px] tracking-[0.12em]"
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
