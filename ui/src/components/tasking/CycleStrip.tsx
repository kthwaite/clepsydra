/**
 * CycleStrip — the cycle picker at the top of the Cycle view.
 *
 * A sink track of tabs: one per cycle (state dot, code, state word), then
 * Backlog with its unassigned-task count, then a "New cycle" button outside
 * the tablist. Selecting a tab writes `cycleSel` — the same store key the
 * ScopeRail uses — so the rail and the strip always agree.
 *
 * Keyboard: React Aria tabs. Arrow keys move focus; Enter or Space selects
 * (manual activation, so arrowing past a cycle does not load it).
 */

import { Tab, TabList, Tabs } from "react-aria-components";
import type { BoardCycle } from "#/api/board";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/cn";
import { FOCUS_RING } from "#/lib/focusRing";
import { useBoardStore } from "#/store/board";
import { cycleStateLabel } from "./board-constants";

/** The `cycleSel` value for the Backlog pseudo-cycle. */
const BACKLOG_KEY = "BACKLOG";

const TAB = cn(
  "flex h-[30px] cursor-pointer items-center gap-2 rounded-full px-3.5 text-mute transition-colors",
  "data-[hovered]:text-ink data-[selected]:bg-raise data-[selected]:font-medium data-[selected]:text-ink",
  FOCUS_RING,
);

/** State word colour: active cobalt, planned mute, closed faint. */
function stateWordClass(state: string): string {
  if (state === "ACTIVE") return "text-accent";
  if (state === "CLOSED") return "text-faint";
  return "text-mute";
}

/** 6px state dot: active cobalt, planned outline, closed faint. */
function StateDot({ state }: { state: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full",
        state === "ACTIVE" && "bg-accent",
        state === "CLOSED" && "bg-faint",
        state !== "ACTIVE" &&
          state !== "CLOSED" &&
          "shadow-[inset_0_0_0_1.5px_var(--mute)]",
      )}
    />
  );
}

interface CycleStripProps {
  cycles: BoardCycle[];
  /** Code of the resolved cycle ("BACKLOG" for the pseudo-cycle). */
  selectedCode: string;
  /** Tasks with no cycle, counted over the same slice the view shows. */
  backlogCount: number;
}

export function CycleStrip({
  cycles,
  selectedCode,
  backlogCount,
}: CycleStripProps) {
  const setCycleSel = useBoardStore((s) => s.setCycleSel);
  const openCycleModal = useBoardStore((s) => s.openCycleModal);

  return (
    <div className="flex flex-wrap items-center gap-1 self-start rounded-[20px] bg-sink p-1 text-[13px]">
      <Tabs
        selectedKey={selectedCode}
        onSelectionChange={(key) => setCycleSel(String(key))}
        keyboardActivation="manual"
      >
        <TabList aria-label="Cycles" className="flex flex-wrap gap-1">
          {cycles.map((c) => (
            <Tab key={c.code} id={c.code} className={TAB}>
              <StateDot state={c.state} />
              {c.code}
              <span className={cn("font-normal", stateWordClass(c.state))}>
                {cycleStateLabel(c.state)}
              </span>
            </Tab>
          ))}
          <Tab id={BACKLOG_KEY} className={TAB}>
            Backlog
            <span className="font-normal tabular-nums text-faint">
              {backlogCount}
            </span>
          </Tab>
        </TabList>
      </Tabs>
      <Button
        variant="ghost"
        size="sm"
        className="ml-1 h-[30px] text-accent data-[hovered]:text-accent"
        onPress={() => openCycleModal({ kind: "new" })}
      >
        New cycle
      </Button>
    </div>
  );
}
