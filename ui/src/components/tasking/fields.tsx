/**
 * Shared form-field primitives for the Tasking board panels
 * (NewTaskModal, TaskEditPanel and the cycle modals).
 *
 * Stone & Lamp (spec §5.5): a sentence-case mute label over a sink input;
 * choice rows are segmented tracks on sink with the selected option raised.
 */

import { useLayoutEffect, useRef } from "react";
import { Radio, RadioGroup } from "#/components/ui/radio-group";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import {
  COL_ORDER,
  type ColLabelFn,
  PRI_LABEL,
  PRI_ORDER,
  priColor,
} from "./board-constants";

// ── EdField ───────────────────────────────────────────────────────────────────

/** Labelled field wrapper: mute label, optional right-hand hint. */
export function EdField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12.5px] text-mute">{label}</span>
        {hint && <span className="text-[12px] text-mute">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

// ── input classes ─────────────────────────────────────────────────────────────

/** Sink input: 38px tall on one line, 10px radius, no hairline. */
export const INPUT_CLS = cn(
  "w-full min-w-0 rounded-[10px] bg-sink px-3 py-2 text-[14px] leading-5.5 text-ink placeholder:text-mute disabled:opacity-45",
  FOCUS_RING_NATIVE,
);

// ── radio-row classes / styles ────────────────────────────────────────────────

/** One option in a segmented choice row (radio or plain button). */
const RADIO_CLS_BASE = cn(
  "flex h-7.5 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] px-1.5 py-0 text-[13px] text-mute transition-colors hover:text-ink",
  FOCUS_RING_NATIVE,
);

/** The sink track a choice row sits in (pair with RADIO_CLS_BASE). */
const CHOICE_TRACK_CLS = "flex w-full gap-0.5 rounded-xl bg-sink p-0.75";

/** Priority fills in the priority colour (kept for the board's chips). */
export const PRI_ON_STYLE: Record<string, React.CSSProperties> =
  Object.fromEntries(
    PRI_ORDER.map((p) => {
      const { bar } = priColor(p);
      // Ground text reads on the hot, ink and mute fills; only Low's faint
      // fill is light enough to take ink.
      const color = p === "P3" ? "var(--ink)" : "var(--ground)";
      return [p, { background: bar, borderColor: bar, color }];
    }),
  );

function TaskRadio({
  value,
  className,
  style,
  children,
  "data-testid": testId,
}: {
  value: string;
  className: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
  "data-testid": string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    inputRef.current?.setAttribute("data-testid", testId);
  }, [testId]);

  return (
    <Radio
      value={value}
      className={className}
      style={style}
      inputRef={inputRef}
    >
      {children}
    </Radio>
  );
}

// ── radio rows ────────────────────────────────────────────────────────────────

/**
 * 5-option status row (board status columns).
 * data-testid: `${testIdPrefix}-status-${colId}`.
 */
export function DispositionRow({
  value,
  onChange,
  testIdPrefix,
  colLabel,
}: {
  value: string;
  onChange: (colId: string) => void;
  testIdPrefix: string;
  /** Resolves a column id to its display label. */
  colLabel: ColLabelFn;
}) {
  return (
    <RadioGroup
      aria-label="Status"
      value={value}
      onChange={onChange}
      segmented
      optionsClassName={CHOICE_TRACK_CLS}
    >
      {COL_ORDER.map((colId) => (
        <TaskRadio
          key={colId}
          value={colId}
          className={RADIO_CLS_BASE}
          data-testid={`${testIdPrefix}-status-${colId}`}
        >
          {colLabel(colId)}
        </TaskRadio>
      ))}
    </RadioGroup>
  );
}

/**
 * 4-option priority row (P0–P3, each with its colour dot).
 * data-testid: `${testIdPrefix}-priority-${pri}`.
 */
export function PriorityRow({
  value,
  onChange,
  testIdPrefix,
}: {
  value: string;
  onChange: (pri: string) => void;
  testIdPrefix: string;
}) {
  return (
    <RadioGroup
      aria-label="Priority"
      value={value}
      onChange={onChange}
      segmented
      optionsClassName={CHOICE_TRACK_CLS}
    >
      {PRI_ORDER.map((p) => (
        <TaskRadio
          key={p}
          value={p}
          className={RADIO_CLS_BASE}
          data-testid={`${testIdPrefix}-priority-${p}`}
        >
          <span
            aria-hidden
            data-testid={`${testIdPrefix}-priority-dot-${p}`}
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: priColor(p).bar }}
          />
          {/* The id stays in the accessible name ("P0 Critical"); the
              visible label is the plain word, per the mockup. */}
          <span className="sr-only">{p}</span>
          {` ${PRI_LABEL[p]}`}
        </TaskRadio>
      ))}
    </RadioGroup>
  );
}
