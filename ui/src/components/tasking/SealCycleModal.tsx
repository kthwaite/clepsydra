/**
 * SealCycleModal — confirm closing (sealing) a cycle.
 *
 * Design source: docs/pkm-redesign/project/board-panels.jsx lines 421-495
 * (EndSprintModal) + styles-board.css .board-modal-sm / .sp-confirm*.
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
import { useBoardStore } from "#/store/board";
import { BoardModalFrame } from "./BoardModalFrame";
import { fmtCycleWindow } from "./board-constants";
import { sealStats } from "./board-stats";
import { CycleMetric } from "./board-presentation";
import { EdField, RADIO_CLS_BASE, RADIO_CLS_ON } from "./fields";

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
    { v: "BACKLOG", label: "→ BACKLOG" },
    ...(nextPlanned
      ? [{ v: nextPlanned.code as CarryChoice, label: `→ ${nextPlanned.code}` }]
      : []),
    { v: "LEAVE", label: "LEAVE IN CYCLE" },
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
      ariaLabel="Seal Cycle"
      widthClassName="w-[460px]"
      backdropTestId="seal-cycle-modal-backdrop"
      modalTestId="seal-cycle-modal"
      onClose={closeCycleModal}
    >
            {/* Header */}
            <div className="flex items-center gap-[10px] border-b border-[var(--rule)] bg-[var(--bg-2)] px-[14px] py-[10px]">
              <span className="cl-display text-[16px] font-extrabold text-[var(--ink)]">
                ■
              </span>
              <span className="cl-display text-[14px] font-extrabold uppercase tracking-[0.06em] text-[var(--ink)]">
                SEAL CYCLE
              </span>
              <span className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.14em] text-[var(--ink-3)]">
                {cycle.code} · {windowLabel}
              </span>
              <button
                type="button"
                className="cl-mono ml-auto cursor-pointer border border-[var(--rule)] px-[7px] py-[2px] text-[var(--fs-xs)] uppercase tracking-[0.14em] text-[var(--ink-3)] hover:border-[var(--hot)] hover:text-[var(--hot)]"
                onClick={closeCycleModal}
                data-testid="seal-cycle-close-btn"
              >
                ESC
              </button>
            </div>

            {/* Body */}
            <div className="flex flex-col gap-[12px] p-[14px]">
              {/* Cycle label */}
              <div
                className="cl-display text-[18px] font-black uppercase leading-none tracking-[0.04em] text-[var(--ink)]"
                data-testid="seal-cycle-label"
              >
                {cycle.label}
              </div>

              {/* Stats row */}
              <div className="flex gap-[20px]" data-testid="seal-cycle-stats">
                <CycleMetric
                  label="COMMITTED"
                  value={committed}
                  testId="seal-cycle-committed"
                />
                <CycleMetric
                  label="SEALED"
                  value={sealed}
                  color="var(--cool)"
                  testId="seal-cycle-sealed"
                />
                <CycleMetric
                  label="CARRYOVER"
                  value={carryover}
                  color={carryover > 0 ? "var(--hot)" : undefined}
                  testId="seal-cycle-carryover"
                />
                <CycleMetric
                  label="RATE"
                  value={`${pct}%`}
                  testId="seal-cycle-rate"
                />
              </div>

              {/* Progress bar */}
              <div className="flex items-center gap-[12px]">
                <div className="h-[8px] flex-1 border border-[var(--rule)] bg-[var(--bg-3)]">
                  <i
                    className="block h-full transition-[width] duration-[240ms]"
                    style={{ width: `${pct}%`, background: "var(--cool)" }}
                    data-testid="seal-cycle-progress-bar"
                  />
                </div>
              </div>

              {/* Carryover routing OR clean-close callout */}
              {carryover > 0 ? (
                <EdField
                  label="UNSEALED CARRYOVER"
                  hint={`${carryover} task${carryover === 1 ? "" : "s"}`}
                >
                  <div
                    className="flex gap-[6px]"
                    data-testid="seal-cycle-carry-opts"
                  >
                    {carryOpts.map((o) => (
                      <button
                        key={o.v}
                        type="button"
                        className={`${RADIO_CLS_BASE} ${carry === o.v ? RADIO_CLS_ON : "hover:text-[var(--ink)] hover:border-[var(--ink-3)]"}`}
                        onClick={() => setCarry(o.v)}
                        data-testid={`seal-cycle-carry-${o.v}`}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </EdField>
              ) : (
                <div
                  className="flex gap-[10px] border border-[var(--rule)] bg-[var(--bg-2)] p-[10px]"
                  data-testid="seal-cycle-clean-callout"
                >
                  <div className="w-[3px] flex-shrink-0 bg-[var(--cool)]" />
                  <div className="cl-mono text-[var(--fs-s)] leading-snug text-[var(--ink-2)]">
                    All committed tasking is SEALED. Clean close.
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-[var(--rule)] bg-[var(--bg-2)] px-[14px] py-[10px]">
              <div className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.12em] text-[var(--ink-3)]">
                {cycle.code} → <b>CLOSED</b>
              </div>
              <div className="flex gap-[8px]">
                <button
                  type="button"
                  className="cl-btn"
                  onClick={closeCycleModal}
                  data-testid="seal-cycle-cancel"
                >
                  CANCEL
                </button>
                <button
                  type="button"
                  className="cl-btn cl-btn-hot"
                  onClick={commit}
                  disabled={patch.isPending}
                  data-testid="seal-cycle-commit"
                >
                  {patch.isPending ? "SEALING…" : "■ SEAL CYCLE"}
                </button>
              </div>
            </div>
    </BoardModalFrame>
  );
}
