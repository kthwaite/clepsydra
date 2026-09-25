import { useShallow } from "zustand/react/shallow";
import type { BoardCycle, BoardTask } from "#/api/board";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { useBoardStore } from "#/store/board";
import { CycleStatePip, fmtCycleWindow, HealthDot } from "./board-constants";
import { type ProjectScope, scopeNameIsRedundant } from "./board-projects";

// ── UNFILED detection ────────────────────────────────────────────────────────

/** Returns true when ≥1 task has a null/empty project. */
export function hasUnfiledTasks(tasks: BoardTask[]): boolean {
  return tasks.some((t) => !t.project);
}

// ── ScopeRail ────────────────────────────────────────────────────────────────

interface ScopeRailProps {
  /** Operations ∪ task slugs — see deriveProjectScopes. */
  projects: ProjectScope[];
  cycles: BoardCycle[];
  tasks: BoardTask[];
}

interface CycleNavRowProps {
  code: string;
  displayCode: string;
  state: string;
  windowLabel: string;
  count: number;
  active: boolean;
  onSelect: () => void;
}

function CycleNavRow({
  code,
  displayCode,
  state,
  windowLabel,
  count,
  active,
  onSelect,
}: CycleNavRowProps) {
  return (
    <button
      type="button"
      data-cycle-code={code}
      className={cn(
        "flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[13.5px] transition-colors",
        FOCUS_RING_NATIVE,
        active ? "bg-accent-tint" : "hover:bg-sink",
      )}
      onClick={onSelect}
    >
      <CycleStatePip state={state} />
      <span className="flex-shrink-0 text-ink">{displayCode}</span>
      <span className="min-w-0 truncate text-[12.5px] text-mute">
        {windowLabel}
      </span>
      <span
        className={cn(
          "ml-auto flex-shrink-0 text-[12.5px] tabular-nums text-mute",
          active && "text-ink",
        )}
      >
        {count}
      </span>
    </button>
  );
}

export function ScopeRail({ projects, cycles, tasks }: ScopeRailProps) {
  // Field selectors (useShallow) — the rail must not re-render on ephemeral
  // modal/edit state changes elsewhere in the store.
  const {
    railOpen,
    opFilter,
    mode,
    cycleSel,
    setRailOpen,
    setOpFilter,
    setCycleSel,
    setMode,
    openCycleModal,
  } = useBoardStore(
    useShallow((s) => ({
      railOpen: s.railOpen,
      opFilter: s.opFilter,
      mode: s.mode,
      cycleSel: s.cycleSel,
      setRailOpen: s.setRailOpen,
      setOpFilter: s.setOpFilter,
      setCycleSel: s.setCycleSel,
      setMode: s.setMode,
      openCycleModal: s.openCycleModal,
    })),
  );

  // Derive task counts
  const unfiledCount = tasks.filter((t) => !t.project).length;
  const showUnfiled = hasUnfiledTasks(tasks);
  const backlogCount = tasks.filter((task) => !task.cycle).length;

  // Collapsed popout — absolute so it floats over the board area
  if (!railOpen) {
    return (
      <button
        type="button"
        className={cn(
          "absolute left-0 top-3 z-20 inline-flex cursor-pointer items-center gap-1.5 rounded-r-full bg-sink px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:text-ink",
          FOCUS_RING_NATIVE,
        )}
        onClick={() => setRailOpen(true)}
        title="Open scope rail"
      >
        <span>Scope</span> ›
      </button>
    );
  }

  return (
    <aside className="flex min-w-0 flex-col overflow-y-auto px-3 pt-2">
      {/* Header */}
      <div className="sticky top-0 z-[2] flex items-center justify-between bg-ground px-3 py-2.5">
        <span className="text-[12.5px] text-mute">Scope</span>
        <button
          type="button"
          className={cn(
            "flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-mute hover:bg-sink hover:text-ink",
            FOCUS_RING_NATIVE,
          )}
          title="Collapse"
          onClick={() => setRailOpen(false)}
        >
          ‹
        </button>
      </div>

      {/* OPERATIONS section */}
      <div className="pb-[10px] pt-1">
        <div className="mb-1.5 flex items-center justify-between px-3 pt-3">
          <span className="font-serif text-[17px] italic text-mute">
            Projects
          </span>
          <span className="text-[12.5px] tabular-nums text-mute">
            {projects.length}
          </span>
        </div>

        {/* ALL OPS row */}
        <button
          type="button"
          className={cn(
            "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[13.5px] transition-colors",
            FOCUS_RING_NATIVE,
            opFilter === "ALL" ? "bg-accent-tint" : "hover:bg-sink",
          )}
          onClick={() => setOpFilter("ALL")}
        >
          {/* neutral square dot */}
          <span className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-faint" />
          <span className="text-ink">All projects</span>
          <span
            className={cn(
              "ml-auto text-[12.5px] tabular-nums text-mute",
              opFilter === "ALL" && "text-ink",
            )}
          >
            {tasks.length}
          </span>
        </button>

        {/* Per-project rows */}
        {projects.map((scope) => {
          // Count by scope key, not slug — a slug-less op's slug is null,
          // and null===null would otherwise match every unfiled task (the
          // same key filterTasks/opFilter use, so the badge always matches
          // what clicking the row reveals).
          const count = tasks.filter((t) => t.project === scope.key).length;
          const active = opFilter === scope.key;
          return (
            <button
              key={scope.key}
              type="button"
              className={cn(
                "flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[13.5px] transition-colors",
                FOCUS_RING_NATIVE,
                active ? "bg-accent-tint" : "hover:bg-sink",
              )}
              onClick={() => setOpFilter(scope.key)}
            >
              {scope.health !== null ? (
                <HealthDot health={scope.health} />
              ) : (
                // Synthesized from task slugs — no page, so no health claim.
                <span className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-faint" />
              )}
              <span className="text-ink">{scope.code}</span>
              {!scopeNameIsRedundant(scope) && (
                <span
                  className="min-w-0 truncate text-[12.5px] text-mute"
                  title={scope.name}
                >
                  {scope.name}
                </span>
              )}
              <span
                className={cn(
                  "ml-auto flex-shrink-0 text-[12.5px] tabular-nums text-mute",
                  active && "text-ink",
                )}
              >
                {count}
              </span>
            </button>
          );
        })}

        {/* UNFILED row — only when ≥1 unfiled task exists */}
        {showUnfiled && (
          <button
            type="button"
            className={cn(
              "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[13.5px] transition-colors",
              FOCUS_RING_NATIVE,
              opFilter === "UNFILED" ? "bg-accent-tint" : "hover:bg-sink",
            )}
            onClick={() => setOpFilter("UNFILED")}
          >
            <span className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-faint" />
            <span className="text-ink">No project</span>
            <span
              className={cn(
                "ml-auto text-[12.5px] tabular-nums text-mute",
                opFilter === "UNFILED" && "text-ink",
              )}
            >
              {unfiledCount}
            </span>
          </button>
        )}
      </div>

      {/* CYCLES section */}
      <div className="pb-[10px] pt-1">
        <div className="mb-1.5 flex items-center justify-between px-3 pt-3">
          <span className="font-serif text-[17px] italic text-mute">
            Cycles
          </span>
          <span className="flex items-center gap-2">
            <button
              type="button"
              className={cn(
                "inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-full text-[15px] leading-none text-mute transition-colors hover:bg-sink hover:text-accent",
                FOCUS_RING_NATIVE,
              )}
              title="New cycle"
              onClick={() => openCycleModal({ kind: "new" })}
            >
              +
            </button>
            <span className="text-[12.5px] tabular-nums text-mute">
              {cycles.length}
            </span>
          </span>
        </div>

        {/* Per-cycle rows */}
        {cycles.map((cycle) => (
          <CycleNavRow
            key={cycle.id}
            code={cycle.code}
            displayCode={cycle.code}
            state={cycle.state}
            windowLabel={fmtCycleWindow(cycle.start, cycle.end)}
            count={tasks.filter((task) => task.cycle === cycle.code).length}
            active={mode === "cycle" && cycleSel === cycle.code}
            onSelect={() => {
              setCycleSel(cycle.code);
              setMode("cycle");
            }}
          />
        ))}

        {/* BKLG pseudo-row */}
        <CycleNavRow
          code="BACKLOG"
          displayCode="Backlog"
          state="BACKLOG"
          windowLabel="Tasks without a Cycle"
          count={backlogCount}
          active={mode === "cycle" && cycleSel === "BACKLOG"}
          onSelect={() => {
            setCycleSel("BACKLOG");
            setMode("cycle");
          }}
        />
      </div>
    </aside>
  );
}
