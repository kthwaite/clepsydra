/**
 * Shared form-field primitives for the Tasking board panels
 * (NewTaskModal + TaskEditPanel).
 *
 * Mirrors the .ed-field / .ed-select / .cap-input / .cap-radio classes from
 * docs/pkm-redesign/project/styles-board.css, translated to Tailwind tokens.
 */

import { COL_LABEL, COL_ORDER, PRI_ORDER } from "./board-constants";

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
  "cl-mono border border-[var(--rule)] px-[10px] py-[5px] text-[var(--fs-xs)] uppercase tracking-[0.14em] text-[var(--ink-3)] cursor-pointer flex-1 text-center transition-[background,color,border-color] duration-[120ms]";

export const RADIO_CLS_ON =
  "bg-[var(--ink)] text-[var(--bg)] border-[var(--ink)]";

const RADIO_CLS_OFF_HOVER =
  "hover:text-[var(--ink)] hover:border-[var(--ink-3)]";

/** Priority on-state fills with the priority colour (cap-radio.pri-*.on). */
export const PRI_ON_STYLE: Record<string, React.CSSProperties> = {
  P0: { background: "var(--hot)", borderColor: "var(--hot)", color: "#000" },
  P1: { background: "var(--warn)", borderColor: "var(--warn)", color: "#000" },
  P2: { background: "var(--cool)", borderColor: "var(--cool)", color: "#000" },
  P3: {
    background: "var(--ink-3)",
    borderColor: "var(--ink-3)",
    color: "#000",
  },
};

export const PRI_OFF_STYLE: Record<string, React.CSSProperties> = {
  P0: { color: "var(--hot)", borderColor: "var(--hot)" },
  P1: { color: "var(--warn)", borderColor: "var(--warn)" },
  P2: { color: "var(--cool)", borderColor: "var(--cool)" },
  P3: { color: "var(--ink-mute)", borderColor: "var(--rule)" },
};

// ── radio rows ────────────────────────────────────────────────────────────────

/**
 * 5-column DISPOSITION radio row (board status columns).
 * data-testid: `${testIdPrefix}-status-${colId}`.
 */
export function DispositionRow({
  value,
  onChange,
  testIdPrefix,
}: {
  value: string;
  onChange: (colId: string) => void;
  testIdPrefix: string;
}) {
  return (
    <div className="flex gap-[6px]">
      {COL_ORDER.map((colId) => (
        <button
          key={colId}
          type="button"
          className={`${RADIO_CLS_BASE} ${value === colId ? RADIO_CLS_ON : RADIO_CLS_OFF_HOVER}`}
          onClick={() => onChange(colId)}
          data-testid={`${testIdPrefix}-status-${colId}`}
        >
          {COL_LABEL[colId] ?? colId}
        </button>
      ))}
    </div>
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
    <div className="flex gap-[6px]">
      {PRI_ORDER.map((p) => (
        <button
          key={p}
          type="button"
          className={RADIO_CLS_BASE}
          style={value === p ? PRI_ON_STYLE[p] : PRI_OFF_STYLE[p]}
          onClick={() => onChange(p)}
          data-testid={`${testIdPrefix}-priority-${p}`}
        >
          {p}
        </button>
      ))}
    </div>
  );
}
