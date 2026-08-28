import type { BoardCycle, BoardOperation, BoardTask } from "#/api/board";
import { FilterBar } from "#/components/filters/FilterBar";
import { Spark } from "#/components/ui/spark";
import { cn } from "#/lib/cn";
import type { FilterField, FilterState } from "#/lib/filters/model";
import { pad2 } from "#/lib/time";
import { useBoardStore } from "#/store/board";
import { HealthDot, healthColor, MODES } from "./board-constants";
import type { ProjectScope } from "./board-projects";

// ── mode glyphs ──────────────────────────────────────────────────────────────

/**
 * Tiny CSS-grid glyph rendered as <i> squares, matching styles-board.css .gl.*
 * cards:    2-col × 2-row grid (4 squares)
 * rows:     3 horizontal bars (full-width, thin height)
 * sprint:   3-col × 1-row grid (3 squares side by side)
 * tl:       3 bars of variable width (timeline stagger)
 */
function ModeGlyph({ gl }: { gl: string }) {
  if (gl === "cards") {
    return (
      <span
        className="inline-grid gap-[1px]"
        style={{
          width: 12,
          height: 10,
          gridTemplateColumns: "1fr 1fr",
          gridTemplateRows: "1fr 1fr",
        }}
      >
        {[0, 1, 2, 3].map((k) => (
          <i
            key={k}
            className="block"
            style={{ background: "currentColor", opacity: 0.85 }}
          />
        ))}
      </span>
    );
  }
  if (gl === "rows") {
    return (
      <span
        className="inline-grid gap-[1px]"
        style={{
          width: 12,
          height: 10,
          gridTemplateColumns: "1fr",
          gridTemplateRows: "1fr 1fr 1fr",
        }}
      >
        {[0, 1, 2].map((k) => (
          <i
            key={k}
            className="block"
            style={{ background: "currentColor", opacity: 0.85, height: 2 }}
          />
        ))}
      </span>
    );
  }
  if (gl === "sprint") {
    return (
      <span
        className="inline-grid gap-[1px]"
        style={{
          width: 12,
          height: 10,
          gridTemplateColumns: "1fr 1fr 1fr",
          gridTemplateRows: "1fr",
        }}
      >
        {[0, 1, 2].map((k) => (
          <i
            key={k}
            className="block"
            style={{ background: "currentColor", opacity: 0.85 }}
          />
        ))}
      </span>
    );
  }
  // tl — 3 variable-width horizontal bars
  return (
    <span
      className="inline-grid"
      style={{
        width: 12,
        height: 10,
        gridTemplateColumns: "1fr",
        gridTemplateRows: "1fr 1fr 1fr",
        gap: 1,
      }}
    >
      <i
        style={{
          display: "block",
          background: "currentColor",
          opacity: 0.85,
          height: 2,
          width: "72%",
        }}
      />
      <i
        style={{
          display: "block",
          background: "currentColor",
          opacity: 0.85,
          height: 2,
          width: "48%",
          marginLeft: "38%",
        }}
      />
      <i
        style={{
          display: "block",
          background: "currentColor",
          opacity: 0.85,
          height: 2,
          width: "60%",
          marginLeft: "14%",
        }}
      />
    </span>
  );
}

// ── BoardHeader ──────────────────────────────────────────────────────────────

interface BoardHeaderProps {
  /** Project scopes (operations ∪ task slugs) — drives the header count. */
  projects: ProjectScope[];
  cycles: BoardCycle[];
  /** Op-filtered tasks (already filtered by opFilter in TaskingScreen). */
  tasks: BoardTask[];
  /** The active operation object when a single op is selected, else null. */
  activeOp: BoardOperation | null;
  /** Task count after the shared FilterBar filtering (the `tasks` prop's length). */
  filteredCount: number;
  /** Task count after op-scoping but before FilterBar filtering. */
  opFilteredCount: number;
  /**
   * SEALED tasks dropped by the list-mode default (see TaskingScreen). Labels
   * the completed toggle; 0 when nothing is hidden or outside backlog mode.
   */
  hiddenCompletedCount?: number;
  /** Facet field configs for the shared FilterBar (options are data-derived). */
  filterFields: readonly FilterField[];
  /** URL-backed filter state, owned by the /tasking route. */
  filterState: FilterState;
  onFilterChange: (next: FilterState) => void;
  onOpenDossier?: (dossier: string) => void;
  sealHistory?: number[];
  sealHistoryPending?: boolean;
  sealHistoryError?: boolean;
  sealHistoryApplicable?: boolean;
}

export function BoardHeader({
  projects,
  cycles,
  tasks,
  activeOp,
  filteredCount,
  opFilteredCount,
  hiddenCompletedCount = 0,
  filterFields,
  filterState,
  onFilterChange,
  onOpenDossier,
  sealHistory = [],
  sealHistoryPending = false,
  sealHistoryError = false,
  sealHistoryApplicable = true,
}: BoardHeaderProps) {
  // Field selectors — the shell must not re-render on ephemeral modal state.
  const mode = useBoardStore((s) => s.mode);
  const setMode = useBoardStore((s) => s.setMode);
  const showCompleted = useBoardStore((s) => s.showCompleted);
  const setShowCompleted = useBoardStore((s) => s.setShowCompleted);

  // Stats
  const open = tasks.filter((t) => t.status !== "SEALED").length;
  const inField = tasks.filter((t) => t.status === "FIELD").length;
  const onHold = tasks.filter((t) => Boolean(t.hold)).length;

  const opHealthColor = healthColor(activeOp?.health ?? "");

  return (
    <header className="flex-none overflow-hidden border-b border-[var(--rule)] bg-[var(--paper-2)]">
      {/* Top strip: title · mode toggles · stats */}
      <div className="flex items-center gap-[18px] px-[var(--pad)] pb-[10px] pt-[12px]">
        {/* Title block */}
        <div className="flex flex-col gap-[1px]">
          <span className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.22em] text-[var(--ink-mute)]">
            {projects.length} {projects.length === 1 ? "project" : "projects"} ·{" "}
            {cycles.length} {cycles.length === 1 ? "cycle" : "cycles"}
          </span>
          <h1 className="font-sans text-[22px] font-black uppercase leading-none tracking-[0.04em] text-[var(--ink)]">
            Task Board
          </h1>
        </div>

        {/* Mode toggles */}
        <div
          role="tablist"
          className="flex border border-[var(--rule)] bg-[var(--paper)]"
        >
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={mode === m.id}
              className={cn(
                "cl-mono inline-flex cursor-pointer items-center gap-[7px] border-r border-[var(--rule)] px-[14px] py-[5px] text-[var(--fs-xs)] uppercase tracking-[0.18em] transition-colors last:border-r-0",
                mode === m.id
                  ? "bg-[var(--ink)] text-[var(--paper)]"
                  : "text-[var(--ink-mute)] hover:bg-[var(--paper-edge)] hover:text-[var(--ink-2)]",
              )}
              onClick={() => setMode(m.id)}
            >
              <ModeGlyph gl={m.gl} />
              {m.label}
            </button>
          ))}
        </div>

        {/* Completed toggle — list mode hides SEALED tasks by default. Absent
            when there is nothing to reveal and nothing is revealed. */}
        {mode === "backlog" && (hiddenCompletedCount > 0 || showCompleted) && (
          <button
            type="button"
            aria-pressed={showCompleted}
            data-testid="board-show-completed"
            className={cn(
              "cl-mono inline-flex cursor-pointer items-center border border-[var(--rule)] px-[12px] py-[5px] text-[var(--fs-xs)] uppercase tracking-[0.18em] transition-colors",
              showCompleted
                ? "bg-[var(--ink)] text-[var(--paper)]"
                : "bg-[var(--paper)] text-[var(--ink-mute)] hover:bg-[var(--paper-edge)] hover:text-[var(--ink-2)]",
            )}
            onClick={() => setShowCompleted(!showCompleted)}
          >
            {showCompleted
              ? "Hide completed"
              : `Show ${hiddenCompletedCount} completed`}
          </button>
        )}

        {/* Stats — pushed to the right */}
        <div className="ml-auto flex items-center gap-[22px]">
          {/* Open */}
          <div className="flex flex-col gap-[1px] text-right">
            <span className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.22em] text-[var(--ink-mute)]">
              Open
            </span>
            <span className="font-sans text-[20px] font-black leading-none tabular-nums text-[var(--ink)]">
              {pad2(open)}
            </span>
          </div>

          {/* In progress */}
          <div className="flex flex-col gap-[1px] text-right">
            <span className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.22em] text-[var(--ink-mute)]">
              In progress
            </span>
            <span
              className="font-sans text-[20px] font-black leading-none tabular-nums"
              style={{ color: "var(--cool)" }}
            >
              {pad2(inField)}
            </span>
          </div>

          {/* Blocked */}
          <div className="flex flex-col gap-[1px] text-right">
            <span className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.22em] text-[var(--ink-mute)]">
              Blocked
            </span>
            <span
              className="font-sans text-[20px] font-black leading-none tabular-nums"
              style={{ color: onHold > 0 ? "var(--hot)" : "var(--ink)" }}
            >
              {pad2(onHold)}
            </span>
          </div>

          {/* Completed over the last 14 days */}
          <div className="flex flex-col gap-[1px] pb-[2px] text-right">
            <span className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.22em] text-[var(--ink-mute)]">
              Completed · 14 days
            </span>
            {!sealHistoryApplicable ? (
              <span className="text-[var(--fs-xs)] text-[var(--ink-mute)]">
                Not applicable
              </span>
            ) : sealHistoryPending ? (
              <span className="text-[var(--fs-xs)] text-[var(--ink-mute)]">
                Loading
              </span>
            ) : sealHistoryError ? (
              <span className="text-[var(--fs-xs)] text-[var(--hot)]">
                Unavailable
              </span>
            ) : sealHistory.length === 0 ||
              sealHistory.every((count) => count === 0) ? (
              <span className="text-[var(--fs-xs)] text-[var(--ink-mute)]">
                No completed tasks
              </span>
            ) : (
              <figure
                className="m-0"
                aria-labelledby="board-completed-history-caption"
              >
                <div aria-hidden="true">
                  <Spark
                    data={sealHistory}
                    width={96}
                    height={26}
                    accent="var(--cool)"
                  />
                </div>
                <figcaption
                  id="board-completed-history-caption"
                  className="sr-only"
                >
                  14-day completed task history: {sealHistory.join(", ")}
                </figcaption>
              </figure>
            )}
          </div>
        </div>
      </div>

      {/* Filter strip: shared FilterBar (text search + facet chips + count) */}
      <FilterBar
        fields={filterFields}
        state={filterState}
        onChange={onFilterChange}
        textInputId="tasking-filter"
        filteredCount={filteredCount}
        totalCount={opFilteredCount}
        className="border-t border-[var(--rule-soft)] bg-[var(--paper)] px-[var(--pad)] py-[7px]"
      />

      {/* Op-meta line — only when a real op is selected */}
      {activeOp && (
        <div className="flex items-center gap-[14px] overflow-hidden whitespace-nowrap border-t border-[var(--rule-soft)] bg-[var(--paper)] px-[var(--pad)] py-[7px] text-[var(--fs-xs)] uppercase tracking-[0.12em] text-[var(--ink-mute)]">
          <HealthDot health={activeOp.health} />
          <span className="font-medium text-[var(--ink)]">{activeOp.name}</span>
          <span className="text-[var(--ink-faint)]">·</span>
          <span>
            LEAD
            <b className="ml-[5px] font-medium text-[var(--ink)]">
              {activeOp.lead ?? "—"}
            </b>
          </span>
          <span className="text-[var(--ink-faint)]">·</span>
          <span>
            HEALTH
            <b
              className="ml-[5px] font-medium"
              style={{ color: opHealthColor }}
            >
              {activeOp.health}
            </b>
          </span>
          <span className="text-[var(--ink-faint)]">·</span>
          <span>
            TARGET
            <b className="ml-[5px] font-medium text-[var(--ink)]">
              {activeOp.target ?? "—"}
            </b>
          </span>
          {activeOp.dossier && (
            <>
              <span className="text-[var(--ink-faint)]">·</span>
              <span>
                DOSSIER{" "}
                <button
                  type="button"
                  className="cursor-pointer border-b border-dotted border-[var(--cool)] text-[var(--cool)] transition-colors hover:bg-[var(--cool)] hover:text-[var(--paper)]"
                  onClick={() => onOpenDossier?.(activeOp.dossier!)}
                >
                  {activeOp.dossier}
                </button>
              </span>
            </>
          )}
          {activeOp.note && (
            <>
              <span className="text-[var(--ink-faint)]">·</span>
              <span className="overflow-hidden text-ellipsis text-[var(--fs-xs)] normal-case tracking-[0.02em] text-[var(--ink-2)]">
                {activeOp.note}
              </span>
            </>
          )}
        </div>
      )}
    </header>
  );
}
