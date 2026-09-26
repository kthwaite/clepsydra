/**
 * NewCycleModal — create a new cadence cycle.
 *
 * Design: the Stone & Lamp vocabulary of TaskingSealCycle (spec §5.5/§5.6):
 * tick + italic serif eyebrow, serif title, segmented Status radios,
 * primary commit button.
 *
 * Opened by openCycleModal({ kind: "new" }).
 * On success: closeCycleModal + setCycleSel(created.code) + setMode("cycle").
 *
 * Uses the shared BoardModalFrame shell.
 */

import { useEffect, useRef, useState } from "react";
import type { BoardCycle } from "#/api/board";
import { useCreateCycle } from "#/api/board";
import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";
import { Radio, RadioGroup } from "#/components/ui/radio-group";
import { isoAddDays } from "#/lib/time";
import { useBoardStore } from "#/store/board";
import {
  BOARD_MODAL_WIDTHS,
  BoardModalFrame,
  ModalEscChip,
} from "./BoardModalFrame";
import { cycleStateLabel, fmtCycleWindow } from "./board-constants";
import { EdField, INPUT_CLS } from "./fields";

// ── newCyclePrefill ───────────────────────────────────────────────────────────

export interface NewCyclePrefill {
  label: string;
  start: string;
  end: string;
}

/**
 * Pure helper — computes default field values for a new cycle.
 *
 * - label = "Cycle " + (cycle count + 1)
 * - start = day after latest cycle end (fallback: now)
 * - end   = start + 6 days
 *
 * The code is no longer prefilled here — the server mints it (petname
 * codes carry no numeric suffix to derive from).
 *
 * @param cycles  Existing board cycles (may be empty).
 * @param now     ISO date string "YYYY-MM-DD" — injected for testability.
 *                Pass today's date in production.
 */
export function newCyclePrefill(
  // `code` is unused here (codes are server-minted); the pick is kept so call
  // sites and fixtures can keep passing board cycles as-is.
  cycles: Pick<BoardCycle, "code" | "end">[],
  now: string,
): NewCyclePrefill {
  const n = cycles.length + 1;

  // Latest cycle end date → start is the day after; fallback to now
  const ends = cycles
    .map((c) => c.end)
    .filter((e): e is string => e != null)
    .sort();
  const lastEnd = ends.length ? ends[ends.length - 1] : now;
  const start = isoAddDays(lastEnd, 1);
  const end = isoAddDays(start, 6);

  return {
    label: `Cycle ${n}`,
    start,
    end,
  };
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
    setCode("");
    setLabel(pf.label);
    setStart(pf.start);
    setEnd(pf.end);
    setState("PLANNED");
    setGoal("");
    // Focus label after state flush
    setTimeout(() => labelRef.current?.focus(), 0);
  }, [isOpen]);

  if (!isOpen) return null;

  const windowLabel = fmtCycleWindow(start, end);

  const commit = () => {
    create.mutate(
      {
        code: code.trim() || undefined,
        label: label.trim() || "Cycle",
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
            New cycle
          </h2>
        </div>
        <ModalEscChip onClose={closeCycleModal} testId="new-cycle-close-btn" />
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-[18px] overflow-y-auto px-8 pt-[22px] pb-[30px]">
        <p className="m-0 text-[15px] leading-normal text-mute tabular-nums">
          {windowLabel}
        </p>

        {/* Name + ID */}
        <div className="grid grid-cols-2 gap-4">
          <EdField label="Name">
            <input
              ref={labelRef}
              type="text"
              aria-label="Name"
              className={INPUT_CLS}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              data-testid="new-cycle-label"
            />
          </EdField>
          <EdField label="ID" hint="optional">
            <input
              type="text"
              className={INPUT_CLS}
              aria-label="ID"
              placeholder="auto (assigned by the server)"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              data-testid="new-cycle-code"
            />
          </EdField>
        </div>

        {/* Window */}
        <div className="grid grid-cols-2 gap-4">
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

        {/* Initial state */}
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <span className="text-[12.5px] text-mute">Status</span>
            <span className="text-[12.5px] text-mute">lifecycle</span>
          </div>
          <RadioGroup
            aria-label="Status"
            value={state}
            onChange={setState}
            segmented
            optionsClassName="rounded-xl p-[3px]"
          >
            {["PLANNED", "ACTIVE"].map((st) => (
              <Radio
                key={st}
                value={st}
                className="h-[34px] min-w-[112px] justify-center rounded-[9px] text-[13.5px]"
                data-testid={`new-cycle-state-${st}`}
              >
                {cycleStateLabel(st)}
              </Radio>
            ))}
          </RadioGroup>
        </div>

        {/* Goal */}
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
      <div className="flex items-center gap-2.5 bg-ground pt-4 pr-[22px] pb-[18px] pl-8">
        <span className="mr-auto flex items-center gap-1.5 text-[12.5px] text-mute">
          <kbd className="rounded-md bg-sink px-1.5 py-px font-sans">⌘↵</kbd>
          create ·
          <kbd className="rounded-md bg-sink px-1.5 py-px font-sans">Esc</kbd>
          cancel
        </span>
        <Button
          variant="secondary"
          className="h-10 rounded-full"
          onPress={closeCycleModal}
          data-testid="new-cycle-cancel"
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          className="h-10"
          onPress={commit}
          isDisabled={create.isPending}
          data-testid="new-cycle-commit"
        >
          {create.isPending ? "Creating…" : "Create cycle"}
        </Button>
      </div>
    </BoardModalFrame>
  );
}
