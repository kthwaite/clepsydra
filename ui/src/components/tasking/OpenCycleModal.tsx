/**
 * OpenCycleModal — confirm opening (activating) a cycle.
 *
 * Design: the Stone & Lamp vocabulary of TaskingSealCycle (spec §5.5/§5.6):
 * tick + italic serif eyebrow, serif title and figures, primary commit.
 *
 * Opened by openCycleModal({ kind: "open", cycleId }).
 * On success: closeCycleModal + setCycleSel(cycle.code).
 */

import type { BoardCycle, BoardTask } from "#/api/board";
import { usePatchCycle } from "#/api/board";
import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";
import { useBoardStore } from "#/store/board";
import { BoardModalFrame, ModalEscChip } from "./BoardModalFrame";
import { fmtCycleWindow } from "./board-constants";
import { cycleStats } from "./board-stats";

// ── shared pieces ─────────────────────────────────────────────────────────────

/** One summary figure: mute label under a serif tabular numeral. */
function OpenStat({
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

/** A quiet note on sink; `tone` colours its tick-sized marker. */
function OpenNote({
  tone,
  testId,
  children,
}: {
  tone: "bg-accent" | "bg-hot";
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <p
      className="m-0 flex items-start gap-2.5 rounded-xl bg-sink px-4 py-3 text-[13.5px] leading-snug text-ink-2"
      data-testid={testId}
    >
      <span
        aria-hidden
        className={`mt-[6px] h-[7px] w-[7px] flex-shrink-0 rounded-[1px] ${tone}`}
      />
      <span>{children}</span>
    </p>
  );
}

// ── OpenCycleModal ────────────────────────────────────────────────────────────

interface OpenCycleModalProps {
  cycle: BoardCycle;
  cycles: BoardCycle[];
  tasks: BoardTask[];
}

export function OpenCycleModal({ cycle, cycles, tasks }: OpenCycleModalProps) {
  const cycleModal = useBoardStore((s) => s.cycleModal);
  const closeCycleModal = useBoardStore((s) => s.closeCycleModal);
  const setCycleSel = useBoardStore((s) => s.setCycleSel);
  const patch = usePatchCycle();

  const isOpen = cycleModal?.kind === "open";
  if (!isOpen) return null;

  // Tasks committed to this cycle
  const items = tasks.filter((t) => t.cycle === cycle.code);
  const stats = cycleStats(items);
  const committed = stats.committed;
  const checkTot = stats.checkTot;

  // Another cycle that is currently ACTIVE (clash warning)
  const clash = cycles.find((c) => c.state === "ACTIVE" && c.id !== cycle.id);

  const windowLabel = fmtCycleWindow(cycle.start, cycle.end);

  const commit = () => {
    patch.mutate(
      { id: cycle.id, patch: { state: "ACTIVE" } },
      {
        onSuccess: () => {
          closeCycleModal();
          setCycleSel(cycle.code);
        },
      },
    );
  };

  return (
    <BoardModalFrame
      ariaLabel="Start cycle"
      widthClassName="w-[540px]"
      backdropTestId="open-cycle-modal-backdrop"
      modalTestId="open-cycle-modal"
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
            Start cycle
          </h2>
        </div>
        <ModalEscChip onClose={closeCycleModal} testId="open-cycle-close-btn" />
      </div>

      {/* Body */}
      <div className="flex flex-col gap-[22px] px-8 pt-[22px] pb-[30px]">
        <div className="flex flex-col gap-1.5">
          <p className="m-0 text-[15px] leading-normal text-mute">
            <span className="text-ink" data-testid="open-cycle-label">
              {cycle.label}
            </span>{" "}
            · {cycle.code} · {windowLabel}
          </p>
          {cycle.goal && (
            <p
              className="m-0 text-[14px] leading-snug text-ink-2"
              data-testid="open-cycle-goal"
            >
              {cycle.goal}
            </p>
          )}
        </div>

        {/* Summary figures */}
        <dl className="m-0 flex gap-9" data-testid="open-cycle-stats">
          <OpenStat
            label="Tasks"
            value={committed}
            testId="open-cycle-committed"
          />
          <OpenStat
            label="Checklist items"
            value={checkTot}
            testId="open-cycle-checks"
          />
          <OpenStat
            label="Target state"
            value="Active"
            tone="text-accent"
            testId="open-cycle-state"
          />
        </dl>

        {committed === 0 && (
          <OpenNote tone="bg-accent" testId="open-cycle-empty-callout">
            No tasks in this cycle. It will start empty; you can add tasks after
            starting it.
          </OpenNote>
        )}

        {clash && (
          <OpenNote tone="bg-hot" testId="open-cycle-clash-callout">
            {`${clash.code} is already Active. Starting this cycle will leave two active cycles. Close ${clash.code} first if that is not intended.`}
          </OpenNote>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2.5 bg-ground pt-4 pr-[22px] pb-[18px] pl-8">
        <span className="mr-auto text-[12.5px] text-mute">
          Sets active cycle to <span className="text-ink">{cycle.code}</span>
        </span>
        <Button
          variant="secondary"
          className="h-10 rounded-full"
          onPress={closeCycleModal}
          data-testid="open-cycle-cancel"
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          className="h-10"
          onPress={commit}
          isDisabled={patch.isPending}
          data-testid="open-cycle-commit"
        >
          {patch.isPending ? "Starting…" : "Start cycle"}
        </Button>
      </div>
    </BoardModalFrame>
  );
}
