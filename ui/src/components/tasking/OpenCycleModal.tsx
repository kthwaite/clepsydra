/**
 * OpenCycleModal — confirm opening (activating) a cycle.
 *
 * Design source: docs/pkm-redesign/project/board-panels.jsx lines 362-419
 * (StartSprintModal) + styles-board.css .board-modal-sm / .sp-confirm*.
 *
 * Opened by openCycleModal({ kind: "open", cycleId }).
 * On success: closeCycleModal + setCycleSel(cycle.code).
 *
 * Small confirm modal (.board-modal-sm = 460px wide in prototype).
 */

import type { BoardCycle, BoardTask } from "#/api/board";
import { usePatchCycle } from "#/api/board";
import { useBoardStore } from "#/store/board";
import {
  BOARD_MODAL_WIDTHS,
  BoardModalFrame,
  ModalEscChip,
} from "./BoardModalFrame";
import { fmtCycleWindow } from "./board-constants";
import { CycleMetric } from "./board-presentation";
import { cycleStats } from "./board-stats";

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
      widthClassName={BOARD_MODAL_WIDTHS.confirm}
      backdropTestId="open-cycle-modal-backdrop"
      modalTestId="open-cycle-modal"
      onClose={closeCycleModal}
    >
      {/* Header */}
      <div className="flex items-center gap-[10px] border-b border-[var(--rule)] bg-[var(--bg-2)] px-[14px] py-[10px]">
        <span
          className="cl-display text-[16px] font-extrabold"
          style={{ color: "var(--cool)" }}
        >
          ▶
        </span>
        <span className="cl-display text-[14px] font-extrabold uppercase tracking-[0.06em] text-[var(--ink)]">
          Start cycle
        </span>
        <span className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.14em] text-[var(--ink-3)]">
          {cycle.code} · {windowLabel}
        </span>
        <ModalEscChip onClose={closeCycleModal} testId="open-cycle-close-btn" />
      </div>

      {/* Body */}
      <div className="flex flex-col gap-[12px] p-[14px]">
        {/* Cycle label */}
        <div
          className="cl-display text-[18px] font-black uppercase leading-none tracking-[0.04em] text-[var(--ink)]"
          data-testid="open-cycle-label"
        >
          {cycle.label}
        </div>

        {/* Goal */}
        {cycle.goal && (
          <div
            className="text-[13px] leading-snug text-[var(--ink-2)]"
            data-testid="open-cycle-goal"
          >
            {cycle.goal}
          </div>
        )}

        {/* Stats row */}
        <div className="flex gap-[20px]" data-testid="open-cycle-stats">
          <CycleMetric
            label="COMMITTED"
            value={committed}
            testId="open-cycle-committed"
          />
          <CycleMetric
            label="CHECKS"
            value={checkTot}
            testId="open-cycle-checks"
          />
          <CycleMetric
            label="Target state"
            value="Active"
            color="var(--cool)"
            testId="open-cycle-state"
          />
        </div>

        {/* No tasks callout */}
        {committed === 0 && (
          <div
            className="flex gap-[10px] border border-[var(--rule)] bg-[var(--bg-2)] p-[10px]"
            data-testid="open-cycle-empty-callout"
          >
            <div className="w-[3px] flex-shrink-0 bg-[var(--warn)]" />
            <div className="cl-mono text-[var(--fs-s)] leading-snug text-[var(--ink-2)]">
              No tasking committed to this cycle yet — it will open empty. Pull
              work in from the backlog after opening.
            </div>
          </div>
        )}

        {/* Double-ACTIVE clash warning */}
        {clash && (
          <div
            className="flex gap-[10px] border border-[var(--rule)] bg-[var(--bg-2)] p-[10px]"
            data-testid="open-cycle-clash-callout"
          >
            <div className="w-[3px] flex-shrink-0 bg-[var(--hot)]" />
            <div className="cl-mono text-[var(--fs-s)] leading-snug text-[var(--ink-2)]">
              <b>{clash.code}</b> is still ACTIVE. Running two live cycles
              splits cadence — seal it first, or proceed to run both in
              parallel.
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-[var(--rule)] bg-[var(--bg-2)] px-[14px] py-[10px]">
        <div className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.12em] text-[var(--ink-3)]">
          moves cadence head to <b>{cycle.code}</b>
        </div>
        <div className="flex gap-[8px]">
          <button
            type="button"
            className="cl-btn"
            onClick={closeCycleModal}
            data-testid="open-cycle-cancel"
          >
            CANCEL
          </button>
          <button
            type="button"
            className="cl-btn cl-btn-hot"
            onClick={commit}
            disabled={patch.isPending}
            data-testid="open-cycle-commit"
          >
            {patch.isPending ? "Starting…" : "Start cycle"}
          </button>
        </div>
      </div>
    </BoardModalFrame>
  );
}
