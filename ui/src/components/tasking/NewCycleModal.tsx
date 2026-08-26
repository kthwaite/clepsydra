/**
 * NewCycleModal — create a new cadence cycle.
 *
 * Design source: docs/pkm-redesign/project/board-panels.jsx lines 274-359
 * (NewSprintModal) + styles-board.css .board-modal* / .sp-confirm* classes.
 *
 * Opened by openCycleModal({ kind: "new" }).
 * On success: closeCycleModal + setCycleSel(created.code) + setMode("cycle").
 *
 * Uses the shared BoardModalFrame shell.
 */

import { useEffect, useRef, useState } from "react";
import type { BoardCycle } from "#/api/board";
import { useCreateCycle } from "#/api/board";
import { isoAddDays } from "#/lib/time";
import { useBoardStore } from "#/store/board";
import {
  BOARD_MODAL_WIDTHS,
  BoardModalFrame,
  ModalEscChip,
} from "./BoardModalFrame";
import { fmtCycleWindow } from "./board-constants";
import { EdField, INPUT_CLS, RADIO_CLS_BASE, RADIO_CLS_ON } from "./fields";

// ── newCyclePrefill ───────────────────────────────────────────────────────────

export interface NewCyclePrefill {
  code: string;
  label: string;
  start: string;
  end: string;
}

/**
 * Pure helper — computes default field values for a new cycle.
 *
 * - code  = "S-" + (max numeric suffix across cycles + 1, min 1)
 * - label = "CYCLE " + same number
 * - start = day after latest cycle end (fallback: now)
 * - end   = start + 6 days
 *
 * @param cycles  Existing board cycles (may be empty).
 * @param now     ISO date string "YYYY-MM-DD" — injected for testability.
 *                Pass today's date in production.
 */
export function newCyclePrefill(
  cycles: Pick<BoardCycle, "code" | "end">[],
  now: string,
): NewCyclePrefill {
  // Max numeric suffix (S-3 → 3, C-01 → 1, etc.)
  const nums = cycles.map((c) => {
    const m = c.code.match(/(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  });
  const n = (nums.length ? Math.max(...nums) : 0) + 1;

  // Latest cycle end date → start is the day after; fallback to now
  const ends = cycles
    .map((c) => c.end)
    .filter((e): e is string => e != null)
    .sort();
  const lastEnd = ends.length ? ends[ends.length - 1] : now;
  const start = isoAddDays(lastEnd, 1);
  const end = isoAddDays(start, 6);

  return {
    code: `S-${n}`,
    label: `CYCLE ${n}`,
    start,
    end,
  };
}

/** "YYYY-MM-DD" → "MM.DD" display string. */
function fmtMD(iso: string): string {
  const parts = iso.split("-");
  if (parts.length === 3) return `${parts[1]}.${parts[2]}`;
  return iso;
}

// ── NewCycleModal ─────────────────────────────────────────────────────────────

interface NewCycleModalProps {
  cycles: BoardCycle[];
  /** Injected "today" for testability. Defaults to real today. */
  now?: string;
}

export function NewCycleModal({ cycles, now }: NewCycleModalProps) {
  const cycleModal = useBoardStore((s) => s.cycleModal);
  const closeCycleModal = useBoardStore((s) => s.closeCycleModal);
  const setCycleSel = useBoardStore((s) => s.setCycleSel);
  const setMode = useBoardStore((s) => s.setMode);
  const create = useCreateCycle();

  const isOpen = cycleModal?.kind === "new";

  // Form state
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [state, setState] = useState("PLANNED");
  const [goal, setGoal] = useState("");

  const labelRef = useRef<HTMLInputElement>(null);

  const todayISO = now ?? new Date().toISOString().slice(0, 10);

  // Re-initialise on open
  // biome-ignore lint/correctness/useExhaustiveDependencies: reinitialise only on open
  useEffect(() => {
    if (!isOpen) return;
    const pf = newCyclePrefill(cycles, todayISO);
    setCode(pf.code);
    setLabel(pf.label);
    setStart(pf.start);
    setEnd(pf.end);
    setState("PLANNED");
    setGoal("");
    // Focus label after state flush
    setTimeout(() => labelRef.current?.focus(), 0);
  }, [isOpen]);

  if (!isOpen) return null;

  const windowLabel =
    start && end
      ? `${fmtMD(start)} — ${fmtMD(end)}`
      : fmtCycleWindow(start, end);

  const commit = () => {
    create.mutate(
      {
        code: code.trim() || undefined,
        label: (label.trim() || "CYCLE").toUpperCase(),
        start,
        end,
        goal: goal.trim() || undefined,
        state: state || undefined,
      },
      {
        onSuccess: (cycle) => {
          closeCycleModal();
          setCycleSel(cycle.code);
          setMode("cycle");
        },
      },
    );
  };

  return (
    <BoardModalFrame
      ariaLabel="New cycle"
      widthClassName={BOARD_MODAL_WIDTHS.cycle}
      backdropTestId="new-cycle-modal-backdrop"
      modalTestId="new-cycle-modal"
      onClose={closeCycleModal}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          commit();
        }
      }}
      constrainHeight
    >
      {/* Header */}
      <div className="flex items-center gap-[10px] border-b border-[var(--rule)] bg-[var(--bg-2)] px-[14px] py-[10px]">
        <span className="cl-display text-[16px] font-extrabold text-[var(--hot)]">
          ◴
        </span>
        <span className="cl-display text-[14px] font-extrabold uppercase tracking-[0.06em] text-[var(--ink)]">
          New cycle
        </span>
        <span className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.14em] text-[var(--ink-3)]">
          {windowLabel} · SET UP A CADENCE WINDOW
        </span>
        <ModalEscChip onClose={closeCycleModal} testId="new-cycle-close-btn" />
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-[12px] overflow-y-auto p-[14px]">
        {/* LABEL + CODE */}
        <div className="grid grid-cols-2 gap-[12px]">
          <EdField label="Name">
            <input
              ref={labelRef}
              type="text"
              aria-label="Name"
              className={INPUT_CLS}
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              data-testid="new-cycle-label"
            />
          </EdField>
          <EdField label="ID" hint="S-NN">
            <input
              type="text"
              className={INPUT_CLS}
              aria-label="ID"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              data-testid="new-cycle-code"
            />
          </EdField>
        </div>

        {/* WINDOW */}
        <div className="grid grid-cols-2 gap-[12px]">
          <EdField label="Start date" hint="start">
            <input
              type="date"
              aria-label="Start date"
              className={INPUT_CLS}
              value={start}
              onChange={(e) => setStart(e.target.value)}
              data-testid="new-cycle-start"
            />
          </EdField>
          <EdField label="End date" hint="end">
            <input
              type="date"
              aria-label="End date"
              className={INPUT_CLS}
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              data-testid="new-cycle-end"
            />
          </EdField>
        </div>

        {/* INITIAL STATE */}
        <EdField label="Status" hint="cadence">
          <div
            className="flex gap-[6px]"
            role="group"
            aria-label="Status"
          >
            {["PLANNED", "ACTIVE"].map((st) => (
              <button
                key={st}
                type="button"
                className={`${RADIO_CLS_BASE} ${state === st ? RADIO_CLS_ON : "hover:text-[var(--ink)] hover:border-[var(--ink-3)]"}`}
                onClick={() => setState(st)}
                data-testid={`new-cycle-state-${st}`}
              >
                {st === "PLANNED" ? "Planned" : "Active"}
              </button>
            ))}
          </div>
        </EdField>

        {/* GOAL */}
        <EdField label="Goal" hint="one line">
          <textarea
            className={`${INPUT_CLS} resize-none`}
            aria-label="Goal"
            rows={2}
            placeholder="What this cycle should achieve"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            data-testid="new-cycle-goal"
          />
        </EdField>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-[var(--rule)] bg-[var(--bg-2)] px-[14px] py-[10px]">
        <div className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.12em] text-[var(--ink-3)]">
          <span className="inline-block border border-[var(--rule)] px-[5px] py-[1px] text-[var(--fs-xs)]">
            ⌘↵
          </span>{" "}
          create ·{" "}
          <span className="inline-block border border-[var(--rule)] px-[5px] py-[1px] text-[var(--fs-xs)]">
            ESC
          </span>{" "}
          cancel
        </div>
        <div className="flex gap-[8px]">
          <button
            type="button"
            className="cl-btn"
            onClick={closeCycleModal}
            data-testid="new-cycle-cancel"
          >
            CANCEL
          </button>
          <button
            type="button"
            className="cl-btn cl-btn-hot"
            onClick={commit}
            disabled={create.isPending}
            data-testid="new-cycle-commit"
          >
            {create.isPending ? "Creating…" : "Create cycle"}
          </button>
        </div>
      </div>
    </BoardModalFrame>
  );
}
