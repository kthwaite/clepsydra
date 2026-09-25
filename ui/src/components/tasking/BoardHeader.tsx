import type { BoardCycle, BoardOperation, BoardTask } from "#/api/board";
import { Tick } from "#/components/codex/Tick";
import { FilterBar } from "#/components/filters/FilterBar";
import { Button } from "#/components/ui/button";
import { Spark } from "#/components/ui/spark";
import { cn } from "#/lib/cn";
import type { FilterField, FilterState } from "#/lib/filters/model";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { useBoardStore } from "#/store/board";
import { HealthDot, healthColor, MODES } from "./board-constants";
import type { ProjectScope } from "./board-projects";

// ── BoardHeader ──────────────────────────────────────────────────────────────

interface BoardHeaderProps {
  /** Project scopes (operations ∪ task slugs) — drives the header count. */
  projects: ProjectScope[];
  cycles: BoardCycle[];
  /** Op-filtered tasks (already filtered by opFilter in TaskingScreen). */
  tasks: BoardTask[];
  /** Tasks in scope before the list-mode hide rule and the FilterBar, so
   *  cycle progress does not move with filters. */
  scopedTasks: BoardTask[];
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
  scopedTasks,
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

  const openTaskModal = useBoardStore((s) => s.openTaskModal);
  const opFilter = useBoardStore((s) => s.opFilter);

  function handleNewTask() {
    // Only preset a real project slug — an op code is not a valid project
    // label for task creation, so a slug-less op (and the ALL/UNFILED
    // sentinels) presets nothing.
    const scoped = projects.find((p) => p.key === opFilter);
    openTaskModal(scoped?.slug ? { project: scoped.slug } : {});
  }

  // Stats
  const open = tasks.filter((t) => t.status !== "SEALED").length;
  const inField = tasks.filter((t) => t.status === "FIELD").length;
  const onHold = tasks.filter((t) => Boolean(t.hold)).length;

  const opHealthColor = healthColor(activeOp?.health ?? "");
  const dossier = activeOp?.dossier;

  // The running cycle, with progress as sealed of all its tasks.
  const activeCycle = cycles.find((c) => c.state === "ACTIVE") ?? null;
  const cycleTasks = activeCycle
    ? scopedTasks.filter((t) => t.cycle === activeCycle.code)
    : [];

  // Title the scope the rail selected, including No project and scopes
  // synthesized from task slugs (no Project page, so no activeOp).
  const scope = projects.find((p) => p.key === opFilter) ?? null;
  const title =
    opFilter === "ALL"
      ? "Task board"
      : opFilter === "UNFILED"
        ? "No project"
        : scope
          ? scope.name || scope.code
          : (activeOp?.name ?? "Task board");
  const cycleDone = cycleTasks.filter((t) => t.status === "SEALED").length;
  const cycleTotal = cycleTasks.length;

  return (
    <header className="flex-none px-10 pt-12">
      <div className="flex flex-wrap items-end gap-x-10 gap-y-6">
        {/* Title block */}
        <div className="flex flex-col gap-2.5">
          <span className="flex items-center gap-2.5">
            <Tick />
            <span className="font-serif text-[19px] italic text-mute">
              {opFilter === "ALL" ? "All projects" : "Project"}
            </span>
          </span>
          <h1 className="font-serif text-[clamp(40px,4.5vw,56px)] leading-none tracking-[-0.015em] text-ink">
            {title}
          </h1>
          <span className="text-[13px] text-mute">
            {projects.length} {projects.length === 1 ? "project" : "projects"} ·{" "}
            {cycles.length} {cycles.length === 1 ? "cycle" : "cycles"}
          </span>
        </div>

        {/* Cycle meta */}
        {activeCycle && (
          <div className="flex flex-col gap-2 pb-1.5 text-[14px] text-mute">
            <span>
              Cycle <span className="text-ink">{activeCycle.code}</span>
              {activeCycle.start && activeCycle.end
                ? ` · ${activeCycle.start} – ${activeCycle.end}`
                : ""}
            </span>
            <span className="flex items-center gap-2.5">
              <span
                role="progressbar"
                aria-label="Cycle progress"
                aria-valuemin={0}
                aria-valuemax={cycleTotal}
                aria-valuenow={cycleDone}
                className="block h-1 w-[120px] overflow-hidden rounded-full bg-sink"
              >
                <span
                  className="block h-1 rounded-full bg-accent"
                  style={{
                    width: `${cycleTotal ? (cycleDone / cycleTotal) * 100 : 0}%`,
                  }}
                />
              </span>
              <span className="tabular-nums">
                {cycleDone} of {cycleTotal}
              </span>
            </span>
          </div>
        )}

        <div className="flex-1" />

        {/* Stats */}
        <div className="flex items-end gap-7 pb-1">
          <Stat label="Open" value={open} />
          <Stat label="In progress" value={inField} accent />
          <Stat label="Blocked" value={onHold} hot={onHold > 0} />
          <div className="flex flex-col gap-1">
            <span className="text-[12.5px] text-mute">Completed · 14 days</span>
            {!sealHistoryApplicable ? (
              <span className="text-[12.5px] text-mute">Not applicable</span>
            ) : sealHistoryPending ? (
              <span className="text-[12.5px] text-mute">Loading</span>
            ) : sealHistoryError ? (
              <span className="text-[12.5px] text-hot">Unavailable</span>
            ) : sealHistory.length === 0 ||
              sealHistory.every((count) => count === 0) ? (
              <span className="text-[12.5px] text-mute">
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
                    accent="var(--accent)"
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

      {/* View switch · completed toggle · New task */}
      <div className="mt-8 flex flex-wrap items-center gap-4">
        <div role="tablist" className="flex gap-1 rounded-full bg-sink p-1">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={mode === m.id}
              className={cn(
                "h-[34px] cursor-pointer rounded-full px-4 text-[14px] transition-colors",
                FOCUS_RING_NATIVE,
                mode === m.id
                  ? "bg-raise font-medium text-ink shadow-sm"
                  : "text-mute hover:text-ink",
              )}
              onClick={() => setMode(m.id)}
            >
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
              "h-9 cursor-pointer rounded-full px-4 text-[13.5px] transition-colors",
              FOCUS_RING_NATIVE,
              showCompleted
                ? "bg-accent-tint text-ink"
                : "bg-sink text-ink-2 hover:text-ink",
            )}
            onClick={() => setShowCompleted(!showCompleted)}
          >
            {showCompleted
              ? "Hide completed"
              : `Show ${hiddenCompletedCount} completed`}
          </button>
        )}

        <div className="flex-1" />

        <Button variant="primary" onPress={handleNewTask}>
          New task
        </Button>
      </div>

      {/* Filter strip: shared FilterBar (text search + facet chips + count) */}
      <FilterBar
        fields={filterFields}
        primaryFieldIds={["project", "status", "pri"]}
        state={filterState}
        onChange={onFilterChange}
        textInputId="tasking-filter"
        filteredCount={filteredCount}
        totalCount={opFilteredCount}
        className="mt-5"
      />

      {/* Op-meta line — only when a real op is selected */}
      {activeOp && (
        <div className="mt-4 flex items-center gap-3 overflow-hidden whitespace-nowrap text-[13px] text-mute">
          <HealthDot health={activeOp.health} />
          <span>
            Lead
            <b className="ml-1.5 font-medium text-ink">
              {activeOp.lead ?? "—"}
            </b>
          </span>
          <span aria-hidden>·</span>
          <span>
            Health
            <b className="ml-1.5 font-medium" style={{ color: opHealthColor }}>
              {activeOp.health}
            </b>
          </span>
          <span aria-hidden>·</span>
          <span>
            Target
            <b className="ml-1.5 font-medium text-ink">
              {activeOp.target ?? "—"}
            </b>
          </span>
          {dossier && (
            <>
              <span aria-hidden>·</span>
              <span>
                Dossier{" "}
                <button
                  type="button"
                  className={cn(
                    "cursor-pointer rounded-sm text-accent hover:underline",
                    FOCUS_RING_NATIVE,
                  )}
                  onClick={() => onOpenDossier?.(dossier)}
                >
                  {dossier}
                </button>
              </span>
            </>
          )}
          {activeOp.note && (
            <>
              <span aria-hidden>·</span>
              <span className="overflow-hidden text-ellipsis text-ink-2">
                {activeOp.note}
              </span>
            </>
          )}
        </div>
      )}
    </header>
  );
}

function Stat({
  label,
  value,
  accent = false,
  hot = false,
}: {
  label: string;
  value: number;
  accent?: boolean;
  hot?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12.5px] text-mute">{label}</span>
      <span
        className={cn(
          "font-serif text-[26px] leading-none tabular-nums",
          hot ? "text-hot" : accent ? "text-accent" : "text-ink",
        )}
      >
        {value}
      </span>
    </div>
  );
}
