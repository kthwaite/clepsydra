import { Dialog, DialogTrigger } from "react-aria-components";
import type { BoardCycle, BoardOperation, BoardTask } from "#/api/board";
import { Tick } from "#/components/codex/Tick";
import { FilterBar } from "#/components/filters/FilterBar";
import { Button } from "#/components/ui/button";
import { Popover } from "#/components/ui/popover";
import { Spark } from "#/components/ui/spark";
import { cn } from "#/lib/cn";
import type { FilterField, FilterState } from "#/lib/filters/model";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { useBoardStore } from "#/store/board";
import { HealthDot, healthColor, MODES } from "./board-constants";
import { type ProjectScope, scopeLabel } from "./board-projects";

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
  const onHold = tasks.filter((t) => t.blocked).length;

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
          ? scopeLabel(scope)
          : (activeOp?.name ?? "Task board");
  const cycleDone = cycleTasks.filter((t) => t.status === "SEALED").length;
  const cycleTotal = cycleTasks.length;

  const activeFacetCount = Object.values(filterState.facets).filter(
    (values) => values.length > 0,
  ).length;

  return (
    <header className="min-w-0 flex-none space-y-3 px-5 py-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-[1_1_180px] items-center gap-2.5">
          <Tick />
          <h1
            className="min-w-0 truncate font-serif text-[30px] leading-tight text-ink"
            title={title}
          >
            {title}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Stat label="Open" value={open} />
          <Stat label="In progress" value={inField} accent />
          <Stat label="Blocked" value={onHold} hot={onHold > 0} />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <DialogTrigger>
            <Button variant="ghost" size="sm">
              Details
            </Button>
            <Popover hideArrow placement="bottom end">
              <Dialog
                aria-label="Board details"
                className="max-h-[min(70vh,560px)] w-[360px] max-w-[calc(100vw-24px)] space-y-5 overflow-y-auto rounded-xl bg-raise p-5 text-[13px] text-ink shadow-lg outline-none [overflow-wrap:anywhere]"
              >
                <div>
                  <h2 className="font-serif text-[24px]">{title}</h2>
                  <p className="mt-1 text-mute">
                    {projects.length}{" "}
                    {projects.length === 1 ? "project" : "projects"} ·{" "}
                    {cycles.length} {cycles.length === 1 ? "cycle" : "cycles"}
                  </p>
                </div>
                {activeCycle && (
                  <div className="space-y-2">
                    <p>
                      Cycle <span className="text-ink">{activeCycle.code}</span>
                      {activeCycle.start && activeCycle.end
                        ? ` · ${activeCycle.start} – ${activeCycle.end}`
                        : ""}
                    </p>
                    <div className="flex items-center gap-2.5">
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
                      <span className="tabular-nums text-mute">
                        {cycleDone} of {cycleTotal}
                      </span>
                    </div>
                  </div>
                )}
                {activeOp && (
                  <div className="space-y-2">
                    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
                      <dt className="text-mute">Lead</dt>
                      <dd>{activeOp.lead ?? "—"}</dd>
                      <dt className="text-mute">Health</dt>
                      <dd className="flex items-center gap-2">
                        <HealthDot health={activeOp.health} />
                        <span style={{ color: opHealthColor }}>
                          {activeOp.health}
                        </span>
                      </dd>
                      <dt className="text-mute">Target</dt>
                      <dd>{activeOp.target ?? "—"}</dd>
                      {dossier && (
                        <>
                          <dt className="text-mute">Dossier</dt>
                          <dd>
                            <button
                              type="button"
                              className={cn(
                                "cursor-pointer rounded-sm text-left text-accent hover:underline",
                                FOCUS_RING_NATIVE,
                              )}
                              onClick={() => onOpenDossier?.(dossier)}
                            >
                              {dossier}
                            </button>
                          </dd>
                        </>
                      )}
                    </dl>
                    {activeOp.note && (
                      <p className="text-ink-2">{activeOp.note}</p>
                    )}
                  </div>
                )}
                <div className="space-y-2">
                  <p className="text-mute">Completed · 14 days</p>
                  {!sealHistoryApplicable ? (
                    <p className="text-mute">Not applicable</p>
                  ) : sealHistoryPending ? (
                    <p className="text-mute">Loading</p>
                  ) : sealHistoryError ? (
                    <p className="text-hot">Unavailable</p>
                  ) : sealHistory.length === 0 ||
                    sealHistory.every((count) => count === 0) ? (
                    <p className="text-mute">No completed tasks</p>
                  ) : (
                    <figure
                      className="m-0"
                      aria-labelledby="board-completed-history-caption"
                    >
                      <div aria-hidden="true">
                        <Spark
                          data={sealHistory}
                          width={240}
                          height={40}
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
              </Dialog>
            </Popover>
          </DialogTrigger>
          <Button variant="primary" size="sm" onPress={handleNewTask}>
            New task
          </Button>
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label="Board view"
          className="flex max-w-full gap-0.5 overflow-x-auto rounded-full bg-sink p-0.5"
        >
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={mode === m.id}
              tabIndex={mode === m.id ? 0 : -1}
              className={cn(
                "h-8 shrink-0 cursor-pointer rounded-full px-3 text-[13px] transition-colors",
                FOCUS_RING_NATIVE,
                mode === m.id
                  ? "bg-raise font-medium text-ink shadow-sm"
                  : "text-mute hover:text-ink",
              )}
              onClick={() => setMode(m.id)}
              onKeyDown={(event) => {
                const index = MODES.findIndex((item) => item.id === m.id);
                let next: number;
                if (event.key === "ArrowRight") {
                  next = (index + 1) % MODES.length;
                } else if (event.key === "ArrowLeft") {
                  next = (index + MODES.length - 1) % MODES.length;
                } else if (event.key === "Home") {
                  next = 0;
                } else if (event.key === "End") {
                  next = MODES.length - 1;
                } else {
                  return;
                }
                event.preventDefault();
                setMode(MODES[next].id);
                event.currentTarget.parentElement
                  ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  ?.[next]?.focus();
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
        {/* Keep search mounted for the board's / keyboard shortcut. Facet
            options live in an overlay rather than pushing cards down. */}
        <FilterBar
          fields={[]}
          state={filterState}
          onChange={onFilterChange}
          textInputId="tasking-filter"
          filteredCount={filteredCount}
          totalCount={opFilteredCount}
          className="min-w-0 flex-[1_1_160px] [&_input]:w-36 [&_input]:min-w-0 [&_input]:flex-1"
        />
        <DialogTrigger>
          <Button
            variant={activeFacetCount > 0 ? "secondary" : "ghost"}
            size="sm"
            className={activeFacetCount > 0 ? "bg-accent-tint" : undefined}
          >
            Filters{activeFacetCount > 0 ? ` · ${activeFacetCount}` : ""}
          </Button>
          <Popover hideArrow placement="bottom end">
            <Dialog
              aria-label="Board filters"
              className="max-h-[min(70vh,560px)] w-[420px] max-w-[calc(100vw-24px)] space-y-3 overflow-y-auto rounded-xl bg-raise p-4 shadow-lg outline-none"
            >
              <h2 className="text-[14px] font-medium text-ink">Filter tasks</h2>
              <FilterBar
                fields={filterFields}
                primaryFieldIds={["project", "status", "pri"]}
                state={filterState}
                onChange={onFilterChange}
                showText={false}
              />
            </Dialog>
          </Popover>
        </DialogTrigger>
        {mode === "backlog" && (hiddenCompletedCount > 0 || showCompleted) && (
          <button
            type="button"
            aria-pressed={showCompleted}
            data-testid="board-show-completed"
            className={cn(
              "h-8 cursor-pointer rounded-full px-3 text-[13px] transition-colors",
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
      </div>
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
    <div className="flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-[12.5px] text-mute">{label}</span>
      <span
        className={cn(
          "text-[14px] font-medium tabular-nums",
          hot ? "text-hot" : accent ? "text-accent" : "text-ink",
        )}
      >
        {value}
      </span>
    </div>
  );
}
