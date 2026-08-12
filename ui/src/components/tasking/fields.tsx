/**
 * Shared form-field primitives for the Tasking board panels
 * (NewTaskModal + TaskEditPanel).
 *
 * Mirrors the .ed-field / .ed-select / .cap-input / .cap-radio classes from
 * docs/pkm-redesign/project/styles-board.css, translated to Tailwind tokens.
 */

import { useLayoutEffect, useRef } from "react";
import { Radio, RadioGroup } from "#/components/ui/radio-group";
import {
  COL_ORDER,
  type ColLabelFn,
  PRI_ORDER,
  priColor,
} from "./board-constants";

// ── EdField ───────────────────────────────────────────────────────────────────

/** Small labelled field wrapper (mono caps label + optional right hint). */
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
    <div className="flex flex-col gap-[5px]">
      <div className="flex items-baseline justify-between gap-[8px]">
        <span className="cl-mono text-[9px] uppercase tracking-[0.16em] text-[var(--ink-mute)]">
          {label}
        </span>
        {hint && (
          <span className="cl-mono text-[9px] uppercase tracking-[0.1em] text-[var(--ink-4)]">
            {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

// ── input / select classes ────────────────────────────────────────────────────

export const INPUT_CLS =
  "cl-mono w-full border border-[var(--rule)] bg-transparent px-[9px] py-[7px] text-[var(--fs-s)] text-[var(--ink)] tracking-[0.04em] outline-none placeholder:text-[var(--ink-4)] focus:border-[var(--hot)]";

export const SELECT_CLS =
  "cl-mono w-full border border-[var(--rule)] bg-[var(--bg-2)] px-[9px] py-[7px] text-[var(--fs-s)] text-[var(--ink)] tracking-[0.04em] outline-none cursor-pointer focus:border-[var(--hot)]";

// ── radio-row classes / styles ────────────────────────────────────────────────

export const RADIO_CLS_BASE =
  "cl-mono border border-[var(--rule)] px-[10px] py-[5px] text-[var(--fs-xs)] uppercase tracking-[0.14em] text-[var(--ink-3)] cursor-pointer flex-1 text-center transition-[background,color,border-color] duration-[120ms] ml-0 data-[hovered]:bg-transparent data-[hovered]:text-[var(--ink-3)] data-[selected]:border-[var(--rule)] data-[selected]:bg-transparent data-[selected]:font-normal data-[selected]:text-[var(--ink-3)]";

export const RADIO_CLS_ON =
  "bg-[var(--ink)] text-[var(--bg)] border-[var(--ink)] data-[hovered]:bg-[var(--ink)] data-[hovered]:text-[var(--bg)] data-[hovered]:border-[var(--ink)] data-[selected]:bg-[var(--ink)] data-[selected]:text-[var(--bg)] data-[selected]:border-[var(--ink)]";

const RADIO_CLS_OFF_HOVER =
  "hover:text-[var(--ink)] hover:border-[var(--ink-3)] data-[hovered]:bg-transparent data-[hovered]:text-[var(--ink)] data-[hovered]:border-[var(--ink-3)]";

/** Priority on-state fills with the priority colour (cap-radio.pri-*.on). */
export const PRI_ON_STYLE: Record<string, React.CSSProperties> =
  Object.fromEntries(
    PRI_ORDER.map((p) => {
      const { bar } = priColor(p);
      return [p, { background: bar, borderColor: bar, color: "#000" }];
    }),
  );

/**
 * Priority off-state outlines with the priority colour, except P3 whose
 * border stays the neutral rule colour rather than a barely-visible mute
 * outline (explicit exception).
 */
export const PRI_OFF_STYLE: Record<string, React.CSSProperties> =
  Object.fromEntries(
    PRI_ORDER.map((p) => {
      const { text } = priColor(p);
      return [
        p,
        { color: text, borderColor: p === "P3" ? "var(--rule)" : text },
      ];
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
 * 5-column DISPOSITION radio row (board status columns).
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
      aria-label="Disposition"
      value={value}
      onChange={onChange}
      optionsClassName="gap-[6px]"
    >
      {COL_ORDER.map((colId) => (
        <TaskRadio
          key={colId}
          value={colId}
          className={`${RADIO_CLS_BASE} ${value === colId ? RADIO_CLS_ON : RADIO_CLS_OFF_HOVER}`}
          data-testid={`${testIdPrefix}-status-${colId}`}
        >
          {colLabel(colId)}
        </TaskRadio>
      ))}
    </RadioGroup>
  );
}

/**
 * 4-column PRIORITY radio row (P0–P3, coloured).
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
      optionsClassName="gap-[6px]"
    >
      {PRI_ORDER.map((p) => (
        <TaskRadio
          key={p}
          value={p}
          className={RADIO_CLS_BASE}
          style={value === p ? PRI_ON_STYLE[p] : PRI_OFF_STYLE[p]}
          data-testid={`${testIdPrefix}-priority-${p}`}
        >
          {p}
        </TaskRadio>
      ))}
    </RadioGroup>
  );
}
