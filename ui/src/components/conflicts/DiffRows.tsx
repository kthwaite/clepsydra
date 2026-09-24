import { useState } from "react";
import { SegmentedControl } from "#/components/ui/segmented-control";
import { cn } from "#/lib/cn";
import type { Choice, Segment } from "#/lib/conflictMerge";

type Hunk = Extract<Segment, { kind: "change" }>;

export const LOCAL_LABEL = "Local (this device)";
export const OTHER_LABEL = "Other (conflict copy)";

/** Lines of unchanged text kept visible on each side of a hunk. */
const CONTEXT_LINES = 3;

const CHOICE_OPTIONS = [
  { id: "local", label: "Local" },
  { id: "other", label: "Other" },
  { id: "both", label: "Both" },
] as const;

function isChoice(value: string): value is Choice {
  return value === "local" || value === "other" || value === "both";
}

function DiffLine({
  line,
  number,
  tone,
}: {
  line: string;
  number: number;
  tone?: "local" | "other";
}) {
  const terminated = line.endsWith("\n");
  return (
    <div
      className={cn(
        "flex min-w-0 gap-3 px-3",
        tone === "local" && "bg-hot/10",
        tone === "other" && "bg-cool/10",
      )}
    >
      <span
        aria-hidden="true"
        className="w-8 shrink-0 select-none text-right tabular-nums text-ink-faint"
      >
        {number}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
        {terminated ? line.slice(0, -1) : line}
        {terminated ? null : (
          <span className="ml-2 select-none text-[10px] uppercase tracking-[0.14em] text-warn">
            ⌁ no newline at end
          </span>
        )}
      </span>
    </div>
  );
}

function LineColumn({
  lines,
  start,
  tone,
}: {
  lines: readonly string[];
  start: number;
  tone?: "local" | "other";
}) {
  return lines.map((line, index) => (
    <DiffLine
      // biome-ignore lint/suspicious/noArrayIndexKey: a line's position is its identity
      key={index}
      line={line}
      number={start + index}
      tone={tone}
    />
  ));
}

/**
 * An unchanged run. Shows up to three lines of context next to each
 * neighbouring hunk and folds the rest behind an expander.
 */
export function SameRun({
  lines,
  localStart,
  otherStart,
  hasBefore,
  hasAfter,
}: {
  lines: readonly string[];
  localStart: number;
  otherStart: number;
  hasBefore: boolean;
  hasAfter: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const head = hasBefore ? CONTEXT_LINES : 0;
  const tail = hasAfter ? CONTEXT_LINES : 0;
  const hidden = lines.length - head - tail;
  const folded = !expanded && hidden > 0;

  const renderRows = (from: number, to: number) => (
    <div className="grid md:grid-cols-2">
      <div>
        <LineColumn lines={lines.slice(from, to)} start={localStart + from} />
      </div>
      {/* The right column repeats the left for the side-by-side layout. */}
      <div aria-hidden="true" className="hidden border-l border-rule md:block">
        <LineColumn lines={lines.slice(from, to)} start={otherStart + from} />
      </div>
    </div>
  );

  if (!folded) return renderRows(0, lines.length);
  return (
    <>
      {head > 0 ? renderRows(0, head) : null}
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="block w-full border-y border-rule-soft bg-paper-2 px-3 py-1 text-left text-[10px] uppercase tracking-[0.16em] text-ink-mute hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        Show {hidden} unchanged {hidden === 1 ? "line" : "lines"}
      </button>
      {tail > 0 ? renderRows(lines.length - tail, lines.length) : null}
    </>
  );
}

function HunkSide({
  label,
  lines,
  start,
  tone,
  kept,
  className,
}: {
  label: string;
  lines: readonly string[];
  start: number;
  tone: "local" | "other";
  kept: boolean;
  className?: string;
}) {
  return (
    <figure
      aria-label={label}
      className={cn(
        "m-0 min-w-0 py-1 transition-opacity",
        !kept && "opacity-45",
        className,
      )}
    >
      {/* Wide screens carry the column headings once, above every hunk. */}
      <figcaption className="px-3 pb-1 text-[9px] uppercase tracking-[0.2em] text-ink-mute md:hidden">
        {label}
      </figcaption>
      {lines.length === 0 ? (
        <p className="px-3 text-ink-faint italic">no lines on this side</p>
      ) : (
        <LineColumn lines={lines} start={start} tone={tone} />
      )}
    </figure>
  );
}

/** One change hunk: local and other side by side, with the keep choice. */
export function ChangeHunk({
  hunk,
  index,
  total,
  localStart,
  otherStart,
  choice,
  onChoice,
}: {
  hunk: Hunk;
  index: number;
  total: number;
  localStart: number;
  otherStart: number;
  choice: Choice;
  onChoice: (id: number, choice: Choice) => void;
}) {
  const number = index + 1;
  return (
    <fieldset
      aria-label={`Change ${number} of ${total}`}
      className="m-0 min-w-0 border-0 border-y border-rule p-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 bg-paper-2 px-3 py-1.5">
        <span className="text-[10px] uppercase tracking-[0.18em] text-accent">
          Change {number}
        </span>
        <SegmentedControl
          label={`Keep for change ${number}`}
          value={choice}
          options={CHOICE_OPTIONS}
          onChange={(value) => {
            if (isChoice(value)) onChoice(hunk.id, value);
          }}
          className="gap-0"
        />
      </div>
      <div className="grid md:grid-cols-2">
        <HunkSide
          label={LOCAL_LABEL}
          lines={hunk.local}
          start={localStart}
          tone="local"
          kept={choice !== "other"}
        />
        <HunkSide
          label={OTHER_LABEL}
          lines={hunk.other}
          start={otherStart}
          tone="other"
          kept={choice !== "local"}
          className="border-t border-rule md:border-t-0 md:border-l"
        />
      </div>
    </fieldset>
  );
}
