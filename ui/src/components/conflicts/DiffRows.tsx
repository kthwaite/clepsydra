import { useState } from "react";
import { Tick } from "#/components/codex/Tick";
import { SegmentedControl } from "#/components/ui/segmented-control";
import { cn } from "#/lib/cn";
import type { Choice, Segment } from "#/lib/conflictMerge";
import { FOCUS_RING } from "#/lib/focusRing";

type Hunk = Extract<Segment, { kind: "change" }>;

export const LOCAL_LABEL = "Local (this device)";
export const REMOTE_LABEL = "Remote (conflict copy)";

/** Lines of unchanged text kept visible on each side of a hunk. */
const CONTEXT_LINES = 3;

// The choice id stays "other": it is the side name in the merge model.
const CHOICE_OPTIONS = [
  { id: "local", label: "Local" },
  { id: "other", label: "Remote" },
  { id: "both", label: "Both" },
] as const;

function isChoice(value: string): value is Choice {
  return value === "local" || value === "other" || value === "both";
}

function DiffLine({ line, number }: { line: string; number: number }) {
  const terminated = line.endsWith("\n");
  return (
    <div className="flex min-w-0 gap-3.5 pr-3">
      <span
        aria-hidden="true"
        className="w-7 shrink-0 select-none text-right tabular-nums text-mute"
      >
        {number}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
        {/* Line bodies are code: the only monospace on the page. */}
        <code>{terminated ? line.slice(0, -1) : line}</code>
        {terminated ? null : (
          <span className="ml-2 select-none text-[12px] italic text-mute">
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
}: {
  lines: readonly string[];
  start: number;
}) {
  return lines.map((line, index) => (
    <DiffLine
      // biome-ignore lint/suspicious/noArrayIndexKey: a line's position is its identity
      key={index}
      line={line}
      number={start + index}
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
    <div className="grid gap-x-2 px-2 md:grid-cols-2">
      <div className="min-w-0">
        <LineColumn lines={lines.slice(from, to)} start={localStart + from} />
      </div>
      {/* The right column repeats the left for the side-by-side layout. */}
      <div aria-hidden="true" className="hidden min-w-0 md:block">
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
        className={cn(
          "mx-4 my-1 block h-7 w-[calc(100%-2rem)] rounded-full bg-ground px-3 font-sans text-[13px] text-mute transition-colors hover:text-ink",
          FOCUS_RING,
        )}
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
  kept,
}: {
  label: string;
  lines: readonly string[];
  start: number;
  kept: boolean;
}) {
  return (
    <figure
      aria-label={label}
      className={cn(
        "m-0 min-w-0 rounded-[10px] py-1 text-ink transition-opacity",
        kept ? "bg-accent-tint" : "opacity-45",
      )}
    >
      {/* Wide screens carry the column headings once, above every hunk. */}
      <figcaption className="px-3 pb-1 font-sans text-[12.5px] text-mute md:hidden">
        {label}
      </figcaption>
      {lines.length === 0 ? (
        <p className="pr-3 pl-[42px] font-sans text-[13px] text-mute italic">
          no lines on this side
        </p>
      ) : (
        <LineColumn lines={lines} start={start} />
      )}
    </figure>
  );
}

/** One change hunk: local and remote side by side, with the keep choice. */
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
      className="m-0 my-1.5 min-w-0 border-0 p-0"
    >
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 pr-4 pb-1.5 pl-5 font-sans">
        <span className="flex items-center gap-2.5">
          <Tick />
          <span className="font-serif text-[19px] italic leading-none text-ink">
            Change {number}
          </span>
        </span>
        <span className="flex-1" />
        <span aria-hidden="true" className="text-[12.5px] text-mute">
          Keep
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
      <div className="grid gap-x-2 gap-y-1 px-2 md:grid-cols-2">
        <HunkSide
          label={LOCAL_LABEL}
          lines={hunk.local}
          start={localStart}
          kept={choice !== "other"}
        />
        <HunkSide
          label={REMOTE_LABEL}
          lines={hunk.other}
          start={otherStart}
          kept={choice !== "local"}
        />
      </div>
    </fieldset>
  );
}
