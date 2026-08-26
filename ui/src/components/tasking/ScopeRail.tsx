import { useShallow } from "zustand/react/shallow";
import type { BoardCycle, BoardOperation, BoardTask } from "#/api/board";
import { cn } from "#/lib/cn";
import { useBoardStore } from "#/store/board";
import {
  CycleStatePip,
  fmtCycleWindow,
  HealthDot,
  opKey,
} from "./board-constants";

// ── UNFILED detection ────────────────────────────────────────────────────────

/**
 * Returns true when ≥1 task has project null/empty OR a project code that
 * doesn't match any operation's `project` field.
 */
export function hasUnfiledTasks(
  tasks: BoardTask[],
  operations: BoardOperation[],
): boolean {
  const knownProjects = new Set(
    operations.map((op) => op.project).filter(Boolean),
  );
  return tasks.some((t) => !t.project || !knownProjects.has(t.project));
}

// ── ScopeRail ────────────────────────────────────────────────────────────────

interface ScopeRailProps {
  operations: BoardOperation[];
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
        "cl-mono flex w-full min-w-0 cursor-pointer items-center gap-2 border-l-2 px-[var(--pad)] py-[5px] text-left transition-colors hover:bg-[var(--paper-edge)]",
        active
          ? "border-l-[var(--hot)] bg-[var(--paper)]"
          : "border-l-transparent",
      )}
      onClick={onSelect}
    >
      <CycleStatePip state={state} />
      <span className="flex-shrink-0 text-[var(--fs-s)] tracking-[0.06em] text-[var(--ink)]">
        {displayCode}
      </span>
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--fs-xs)] tracking-[0.04em] text-[var(--ink-mute)]">
        {windowLabel}
      </span>
      <span
        className={cn(
          "ml-auto min-w-[20px] flex-shrink-0 border border-[var(--rule)] px-[4px] text-center text-[var(--fs-xs)] tabular-nums tracking-[0.08em] text-[var(--ink-mute)]",
          active && "border-[var(--ink-mute)] text-[var(--ink)]",
        )}
      >
        {count}
      </span>
    </button>
  );
}

export function ScopeRail({ operations, cycles, tasks }: ScopeRailProps) {
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
    openTaskModal,
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
      openTaskModal: s.openTaskModal,
      openCycleModal: s.openCycleModal,
    })),
  );

  // Derive task counts
  const knownProjects = new Set(
    operations.map((op) => op.project).filter(Boolean),
  );

  const unfiledCount = tasks.filter(
    (t) => !t.project || !knownProjects.has(t.project),
  ).length;

  const showUnfiled = hasUnfiledTasks(tasks, operations);
  const backlogCount = tasks.filter((task) => !task.cycle).length;

  function handleNewTasking() {
    if (opFilter === "ALL" || opFilter === "UNFILED") {
      openTaskModal({});
      return;
    }
    // Only preset a real project slug — an op code is not a valid project
    // label for task creation, so an op without a slug presets nothing.
    const activeOp = operations.find((op) => opKey(op) === opFilter);
    const project = activeOp ? (activeOp.project ?? undefined) : opFilter;
    openTaskModal(project ? { project } : {});
  }

  // Collapsed popout — absolute so it floats over the board area
  if (!railOpen) {
    return (
      <button
        type="button"
        className="absolute left-0 top-3 z-20 inline-flex cursor-pointer items-center gap-1.5 border border-l-0 border-[var(--rule)] bg-[var(--paper-2)] px-[9px] py-[7px] text-[var(--fs-xs)] uppercase tracking-[0.18em] text-[var(--ink-2)] transition-colors hover:border-[var(--hot)] hover:text-[var(--hot)]"
        onClick={() => setRailOpen(true)}
        title="Open scope rail"
      >
        <span>Scope</span> ›
      </button>
    );
  }

  return (
    <aside className="flex min-w-0 flex-col overflow-y-auto border-r border-[var(--rule)] bg-[var(--paper-2)]">
      {/* Header */}
      <div className="sticky top-0 z-[2] flex items-center justify-between border-b border-[var(--rule)] bg-[var(--paper-2)] px-[var(--pad)] py-[10px]">
        <span className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.22em] text-[var(--ink-mute)]">
          Scope
        </span>
        <button
          type="button"
          className="cl-mono cursor-pointer text-[var(--fs-s)] text-[var(--ink-mute)] hover:text-[var(--ink)]"
          title="Collapse"
          onClick={() => setRailOpen(false)}
        >
          ‹
        </button>
      </div>

      {/* NEW TASKING */}
      <button
        type="button"
        className="mx-[var(--pad)] my-[10px] flex cursor-pointer items-center gap-2 border border-[var(--hot)] px-[10px] py-[8px] text-[var(--fs-s)] uppercase tracking-[0.18em] text-[var(--hot)] transition-colors hover:bg-[var(--hot)] hover:text-black"
        onClick={handleNewTasking}
      >
        <span className="text-[14px] font-bold leading-none">+</span>
        New task
      </button>

      {/* OPERATIONS section */}
      <div className="pb-[10px] pt-1">
        <div className="mx-0 mb-1 mt-1 flex items-center justify-between border-b border-[var(--rule)] px-[var(--pad)] pb-[5px] pt-1">
          <span className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.22em] text-[var(--ink-mute)]">
            Projects
          </span>
          <span className="cl-mono text-[var(--fs-xs)] tabular-nums tracking-[0.1em] text-[var(--ink-mute)]">
            {operations.length}
          </span>
        </div>

        {/* ALL OPS row */}
        <button
          type="button"
          className={cn(
            "cl-mono flex w-full cursor-pointer items-center gap-2 border-l-2 px-[var(--pad)] py-[5px] text-left transition-colors hover:bg-[var(--paper-edge)]",
            opFilter === "ALL"
              ? "border-l-[var(--hot)] bg-[var(--paper)]"
              : "border-l-transparent",
          )}
          onClick={() => setOpFilter("ALL")}
        >
          {/* neutral square dot */}
          <span className="inline-block h-[7px] w-[7px] flex-shrink-0 border border-[var(--ink-mute)]" />
          <span className="text-[var(--fs-s)] tracking-[0.08em] text-[var(--ink)]">
            All projects
          </span>
          <span
            className={cn(
              "ml-auto min-w-[20px] border border-[var(--rule)] px-[4px] text-center text-[var(--fs-xs)] tabular-nums tracking-[0.08em] text-[var(--ink-mute)]",
              opFilter === "ALL" &&
                "border-[var(--ink-mute)] text-[var(--ink)]",
            )}
          >
            {tasks.length}
          </span>
        </button>

        {/* Per-operation rows */}
        {operations.map((op) => {
          // Count by opKey, not op.project — a slug-less op's own project
          // is null, and null===null would otherwise match every unfiled
          // task (the same key filterTasks/opFilter use, so the badge
          // always matches what clicking the row reveals).
          const key = opKey(op);
          const count = tasks.filter((t) => t.project === key).length;
          const active = opFilter === key;
          return (
            <button
              key={op.id}
              type="button"
              className={cn(
                "cl-mono flex w-full min-w-0 cursor-pointer items-center gap-2 border-l-2 px-[var(--pad)] py-[5px] text-left transition-colors hover:bg-[var(--paper-edge)]",
                active
                  ? "border-l-[var(--hot)] bg-[var(--paper)]"
                  : "border-l-transparent",
              )}
              onClick={() => setOpFilter(opKey(op))}
            >
              <HealthDot health={op.health} />
              <span className="text-[var(--fs-s)] tracking-[0.08em] text-[var(--ink)]">
                {op.code}
              </span>
              <span
                className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--fs-xs)] uppercase tracking-[0.04em] text-[var(--ink-mute)]"
                title={op.name}
              >
                {op.name}
              </span>
              <span
                className={cn(
                  "ml-auto min-w-[20px] flex-shrink-0 border border-[var(--rule)] px-[4px] text-center text-[var(--fs-xs)] tabular-nums tracking-[0.08em] text-[var(--ink-mute)]",
                  active && "border-[var(--ink-mute)] text-[var(--ink)]",
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
              "cl-mono flex w-full cursor-pointer items-center gap-2 border-l-2 px-[var(--pad)] py-[5px] text-left transition-colors hover:bg-[var(--paper-edge)]",
              opFilter === "UNFILED"
                ? "border-l-[var(--hot)] bg-[var(--paper)]"
                : "border-l-transparent",
            )}
            onClick={() => setOpFilter("UNFILED")}
          >
            <span className="inline-block h-[7px] w-[7px] flex-shrink-0 border border-[var(--ink-mute)]" />
            <span className="text-[var(--fs-s)] tracking-[0.08em] text-[var(--ink)]">
              No project
            </span>
            <span
              className={cn(
                "ml-auto min-w-[20px] border border-[var(--rule)] px-[4px] text-center text-[var(--fs-xs)] tabular-nums tracking-[0.08em] text-[var(--ink-mute)]",
                opFilter === "UNFILED" &&
                  "border-[var(--ink-mute)] text-[var(--ink)]",
              )}
            >
              {unfiledCount}
            </span>
          </button>
        )}
      </div>

      {/* CYCLES section */}
      <div className="pb-[10px] pt-1">
        <div className="mx-0 mb-1 mt-1 flex items-center justify-between border-b border-[var(--rule)] px-[var(--pad)] pb-[5px] pt-1">
          <span className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.22em] text-[var(--ink-mute)]">
            Cycles
          </span>
          <span className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex h-[16px] w-[16px] cursor-pointer items-center justify-center border border-[var(--rule)] text-[13px] leading-none text-[var(--ink-mute)] transition-colors hover:border-[var(--hot)] hover:text-[var(--hot)]"
              title="New cycle"
              onClick={() => openCycleModal({ kind: "new" })}
            >
              +
            </button>
            <span className="cl-mono text-[var(--fs-xs)] tabular-nums tracking-[0.1em] text-[var(--ink-mute)]">
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
