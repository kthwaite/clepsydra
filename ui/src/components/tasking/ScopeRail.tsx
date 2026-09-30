import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { BoardCycle, BoardTask } from "#/api/board";
import { useWidthDrag, WidthResizer } from "#/components/ui/width-resizer";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import {
  clampRailWidth,
  SCOPE_RAIL_DEFAULT,
  SCOPE_RAIL_MAX,
  SCOPE_RAIL_MIN,
  useBoardStore,
} from "#/store/board";
import { CycleStatePip, fmtCycleWindow, HealthDot } from "./board-constants";
import { type ProjectScope, scopeLabel } from "./board-projects";

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
      <span className="min-w-0 flex-1 truncate text-ink" title={displayCode}>
        {displayCode}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-[12.5px] text-mute"
        title={windowLabel}
      >
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
    railWidth,
    opFilter,
    mode,
    cycleSel,
    setRailOpen,
    setRailWidth,
    setOpFilter,
    setCycleSel,
    setMode,
    openCycleModal,
  } = useBoardStore(
    useShallow((s) => ({
      railOpen: s.railOpen,
      railWidth: s.railWidth,
      opFilter: s.opFilter,
      mode: s.mode,
      cycleSel: s.cycleSel,
      setRailOpen: s.setRailOpen,
      setRailWidth: s.setRailWidth,
      setOpFilter: s.setOpFilter,
      setCycleSel: s.setCycleSel,
      setMode: s.setMode,
      openCycleModal: s.openCycleModal,
    })),
  );
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const width = previewWidth ?? clampRailWidth(railWidth);
  const { onDragStart } = useWidthDrag({
    width,
    scale: 1,
    onPreview: (nextWidth) => setPreviewWidth(clampRailWidth(nextWidth)),
    onCommit: (nextWidth) => {
      setRailWidth(nextWidth);
      setPreviewWidth(null);
    },
  });

  // Derive task counts
  const unfiledCount = tasks.filter((t) => !t.project).length;
  const showUnfiled = hasUnfiledTasks(tasks);
  const backlogCount = tasks.filter((task) => !task.cycle).length;

  if (!railOpen) {
    return (
      <aside
        aria-label="Board scope"
        className="h-full w-10 shrink-0 px-1 pt-3"
      >
        <button
          type="button"
          className={cn(
            "flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-sink text-ink-2 transition-colors hover:text-ink",
            FOCUS_RING_NATIVE,
          )}
          onClick={() => setRailOpen(true)}
          title="Open scope rail"
          aria-label="Open scope rail"
          aria-expanded={false}
        >
          <span aria-hidden="true">›</span>
        </button>
      </aside>
    );
  }

  return (
    <aside
      aria-label="Board scope"
      className="relative h-full min-h-0 shrink-0"
      style={{ width }}
    >
      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-x-hidden overflow-y-auto px-2 pb-4 pt-2">
        {/* Header */}
        <div className="sticky top-0 z-[2] flex shrink-0 items-center justify-between bg-ground px-3 py-2.5">
          <span className="text-[12.5px] text-mute">Scope</span>
          <button
            type="button"
            className={cn(
              "flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-mute hover:bg-sink hover:text-ink",
              FOCUS_RING_NATIVE,
            )}
            title="Collapse"
            aria-label="Collapse scope rail"
            aria-expanded={true}
            onClick={() => setRailOpen(false)}
          >
            ‹
          </button>
        </div>

        {/* OPERATIONS section */}
        <div className="shrink-0 pb-[10px] pt-1">
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
            <span className="min-w-0 truncate text-ink" title="All projects">
              All projects
            </span>
            <span
              className={cn(
                "ml-auto shrink-0 text-[12.5px] tabular-nums text-mute",
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
                title={
                  scope.name ? `${scope.name} (${scope.code})` : scope.code
                }
                aria-pressed={active}
              >
                {scope.health !== null ? (
                  <HealthDot health={scope.health} />
                ) : (
                  // Synthesized from task slugs — no page, so no health claim.
                  <span className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-faint" />
                )}
                <span
                  className="min-w-0 flex-1 truncate text-ink"
                  title={scopeLabel(scope)}
                >
                  {scopeLabel(scope)}
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
              <span className="min-w-0 truncate text-ink" title="No project">
                No project
              </span>
              <span
                className={cn(
                  "ml-auto shrink-0 text-[12.5px] tabular-nums text-mute",
                  opFilter === "UNFILED" && "text-ink",
                )}
              >
                {unfiledCount}
              </span>
            </button>
          )}
        </div>

        {/* CYCLES section */}
        <div className="shrink-0 pb-[10px] pt-1">
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
      </div>
      <WidthResizer
        label="Resize scope rail"
        width={width}
        min={SCOPE_RAIL_MIN}
        max={SCOPE_RAIL_MAX}
        step={16}
        onWidth={setRailWidth}
        onReset={() => setRailWidth(SCOPE_RAIL_DEFAULT)}
        onDragStart={onDragStart}
        className="right-0 translate-x-1/2 touch-none"
      />
    </aside>
  );
}
