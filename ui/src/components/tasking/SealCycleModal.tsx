/**
 * SealCycleModal — confirm closing (sealing) a cycle.
 *
 * Design source: Stone & Lamp mockup TaskingSealCycle (spec §5.5/§5.6):
 * tick + italic serif eyebrow, serif title and figures, a segmented
 * radio group for the incomplete-task move, primary commit button.
 *
 * Opened by openCycleModal({ kind: "seal", cycleId }).
 * On success: closeCycleModal (caller stays on current view).
 *
 * carry_to wire contract:
 *   "BACKLOG"       → send { carry_to: "BACKLOG" }
 *   <cycle code>    → send { carry_to: "<code>" }
 *   "LEAVE"         → omit carry_to key entirely
 */

import { useEffect, useState } from "react";
import type { BoardCycle, BoardTask } from "#/api/board";
import { usePatchCycle } from "#/api/board";
import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";
import { Radio, RadioGroup } from "#/components/ui/radio-group";
import { useBoardStore } from "#/store/board";
import { BoardModalFrame, ModalEscChip } from "./BoardModalFrame";
import { fmtCycleWindow } from "./board-constants";
import { sealStats } from "./board-stats";

// ── shared pieces ─────────────────────────────────────────────────────────────

/** One summary figure: mute label under a serif tabular numeral. */
function SealStat({
  label,
  value,
  tone = "text-ink",
  testId,
}: {
  label: string;
  value: number | string;
  tone?: string;
  testId: string;
}) {
  return (
    <div className="flex flex-col-reverse gap-1.5">
      <dt className="text-[12.5px] text-mute">{label}</dt>
      <dd
        className={`m-0 font-serif text-[36px] leading-none tabular-nums ${tone}`}
        data-testid={testId}
      >
        {value}
      </dd>
    </div>
  );
}

// ── SealCycleModal ────────────────────────────────────────────────────────────

type CarryChoice = "BACKLOG" | string | "LEAVE";

interface SealCycleModalProps {
  cycle: BoardCycle;
  cycles: BoardCycle[];
  tasks: BoardTask[];
}

export function SealCycleModal({ cycle, cycles, tasks }: SealCycleModalProps) {
  const cycleModal = useBoardStore((s) => s.cycleModal);
  const closeCycleModal = useBoardStore((s) => s.closeCycleModal);
  const patch = usePatchCycle();

  const isOpen = cycleModal?.kind === "seal";

  const [carry, setCarry] = useState<CarryChoice>("BACKLOG");

  // Reset carry to BACKLOG on each open
  useEffect(() => {
    if (isOpen) setCarry("BACKLOG");
  }, [isOpen]);

  if (!isOpen) return null;

  const stats = sealStats(tasks, cycle.code);
  const { committed, sealed, carryover, pct } = stats;

  // Next PLANNED cycle (for carry-to option)
  const nextPlanned = cycles.find(
    (c) => c.state === "PLANNED" && c.id !== cycle.id,
  );

  const carryOpts: { v: CarryChoice; label: string }[] = [
    { v: "BACKLOG", label: "Move to Backlog" },
    ...(nextPlanned
      ? [
          {
            v: nextPlanned.code as CarryChoice,
            label: `Move to ${nextPlanned.code}`,
          },
        ]
      : []),
    { v: "LEAVE", label: "Keep in this cycle" },
  ];

  const windowLabel = fmtCycleWindow(cycle.start, cycle.end);

  const commit = () => {
    // carry_to absent = leave tasks in cycle; "BACKLOG" or code = route them
    const carryTo = carry === "LEAVE" ? undefined : carry;
    patch.mutate(
      {
        id: cycle.id,
        patch: {
          state: "CLOSED",
          ...(carryTo !== undefined ? { carry_to: carryTo } : {}),
        },
      },
      {
        onSuccess: () => {
          closeCycleModal();
        },
      },
    );
  };

  return (
    <BoardModalFrame
      ariaLabel="Close cycle"
      widthClassName="w-[540px]"
      backdropTestId="seal-cycle-modal-backdrop"
      modalTestId="seal-cycle-modal"
      onClose={closeCycleModal}
    >
      {/* Header: tick eyebrow + serif title */}
      <div className="flex items-start gap-3 pt-[26px] pr-[22px] pl-8">
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-2.5">
            <Tick />
            <span className="font-serif text-[19px] italic text-mute">
              Cycle
            </span>
          </span>
          <h2 className="m-0 font-serif text-[36px] font-normal leading-none tracking-[-0.01em] text-ink">
            Close cycle
          </h2>
        </div>
        <ModalEscChip onClose={closeCycleModal} testId="seal-cycle-close-btn" />
      </div>

      {/* Body */}
      <div className="flex flex-col gap-[22px] px-8 pt-[22px] pb-[30px]">
        <p className="m-0 text-[15px] leading-normal text-mute">
          <span className="text-ink" data-testid="seal-cycle-label">
            {cycle.label}
          </span>{" "}
          · {cycle.code} · {windowLabel}
        </p>

        {/* Summary figures */}
        <dl className="m-0 flex gap-9" data-testid="seal-cycle-stats">
          <SealStat
            label="Tasks"
            value={committed}
            testId="seal-cycle-committed"
          />
          <SealStat
            label="Done"
            value={sealed}
            tone="text-accent"
            testId="seal-cycle-sealed"
          />
          <SealStat
            label="Incomplete tasks"
            value={carryover}
            tone={carryover > 0 ? "text-hot" : "text-ink"}
            testId="seal-cycle-carryover"
          />
          <SealStat
            label="Completion"
            value={`${pct}%`}
            testId="seal-cycle-rate"
          />
        </dl>

        {/* Progress bar */}
        <span className="block h-1.5 overflow-hidden rounded-full bg-sink">
          <i
            className="block h-full rounded-full bg-accent transition-[width] duration-[240ms]"
            style={{ width: `${pct}%` }}
            data-testid="seal-cycle-progress-bar"
          />
        </span>

        {/* Carryover routing OR clean-close note */}
        {carryover > 0 ? (
          <div className="mt-2 flex flex-col gap-2.5">
            <div className="flex items-baseline justify-between">
              <span className="text-[14px] font-medium text-ink">
                Incomplete tasks
              </span>
              <span className="text-[12.5px] text-mute">
                {`${carryover} task${carryover === 1 ? "" : "s"}`}
              </span>
            </div>
            <RadioGroup
              aria-label="Incomplete tasks"
              value={carry}
              onChange={setCarry}
              segmented
              optionsClassName="w-full rounded-xl p-[3px]"
              data-testid="seal-cycle-carry-opts"
            >
              {carryOpts.map((o) => (
                <Radio
                  key={o.v}
                  value={o.v}
                  className="h-[34px] flex-1 justify-center rounded-[9px] text-[13.5px]"
                  data-testid={`seal-cycle-carry-${o.v}`}
                >
                  {o.label}
                </Radio>
              ))}
            </RadioGroup>
          </div>
        ) : (
          <p
            className="m-0 flex items-center gap-2.5 rounded-xl bg-sink px-4 py-3 text-[13.5px] leading-snug text-ink-2"
            data-testid="seal-cycle-clean-callout"
          >
            <Tick />
            All tasks are done. This cycle is ready to close.
          </p>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2.5 bg-ground pt-4 pr-[22px] pb-[18px] pl-8">
        <span className="mr-auto text-[12.5px] text-mute">
          {cycle.code} → Closed
        </span>
        <Button
          variant="secondary"
          className="h-10 rounded-full"
          onPress={closeCycleModal}
          data-testid="seal-cycle-cancel"
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          className="h-10"
          onPress={commit}
          isDisabled={patch.isPending}
          data-testid="seal-cycle-commit"
        >
          {patch.isPending ? "Closing…" : "Close cycle"}
        </Button>
      </div>
    </BoardModalFrame>
  );
}
