import type { FindKind, Motion } from "../core/ast";
import { firstNonBlank, type Line } from "./lines";
import type { LinePos, VimState } from "./types";
import { wordBack, wordEnd, wordForward } from "./words";

export type MotionTarget =
  /** A character position; `inclusive` widens operator ranges by one char. */
  | { kind: "char"; pos: LinePos; inclusive: boolean }
  /** A line target: operators act linewise, plain moves go to (li, off). */
  | { kind: "line"; li: number; off: number };

export interface MotionResolution {
  /** Null when the motion fails (e.g. `f` with no match): command no-ops. */
  target: MotionTarget | null;
  /** State updates that apply even when the motion fails (vim's lastFind). */
  patch?: Partial<VimState>;
}

function clampLine(lines: Line[], li: number): number {
  return Math.max(0, Math.min(li, lines.length - 1));
}

/**
 * Find the `count`-th occurrence of `char` on `text` for f/t/F/T semantics,
 * scanning from `fromOff`. Returns the resulting column or null.
 */
function findInLine(
  text: string,
  char: string,
  kind: FindKind,
  count: number,
  fromOff: number,
): number | null {
  const forward = kind === "f" || kind === "t";
  let i = fromOff;
  for (let n = 0; n < count; n++) {
    i = forward
      ? text.indexOf(char, i + 1)
      : i <= 0
        ? -1
        : text.lastIndexOf(char, i - 1);
    if (i === -1) return null;
  }
  if (kind === "t") return i - 1;
  if (kind === "T") return i + 1;
  return i;
}

function resolveFind(
  lines: Line[],
  from: LinePos,
  kind: FindKind,
  char: string,
  count: number,
  skipAdjacent: boolean,
): MotionTarget | null {
  const text = lines[from.li].text;
  const forward = kind === "f" || kind === "t";
  let base = from.off;
  // `;` repeat of t/T skips a target the cursor is already touching.
  if (skipAdjacent && kind === "t" && text[from.off + 1] === char) base += 1;
  if (skipAdjacent && kind === "T" && text[from.off - 1] === char) base -= 1;
  const off = findInLine(text, char, kind, count, base);
  if (off === null) return null;
  // A find that doesn't move the cursor fails (vim beeps).
  if (forward ? off <= from.off : off >= from.off) return null;
  return {
    kind: "char",
    pos: { li: from.li, off },
    inclusive: forward,
  };
}

const REVERSED: Record<FindKind, FindKind> = {
  f: "F",
  F: "f",
  t: "T",
  T: "t",
};

/**
 * Resolve a motion from `from` to a target in (line, column) space.
 * `count` is null when no count was typed (`G` vs `5G`).
 */
export function resolveMotion(
  lines: Line[],
  from: LinePos,
  state: VimState,
  motion: Motion,
  count: number | null,
): MotionResolution {
  const n = count ?? 1;
  const line = lines[from.li];

  switch (motion.t) {
    case "char": {
      const off = Math.max(
        0,
        Math.min(from.off + motion.dir * n, line.text.length),
      );
      return {
        target: { kind: "char", pos: { li: from.li, off }, inclusive: false },
      };
    }
    case "line-vert": {
      const li = clampLine(lines, from.li + motion.dir * n);
      const goal = state.goalColumn ?? from.off;
      const off = Math.min(goal, Math.max(0, lines[li].text.length - 1));
      return {
        target: { kind: "line", li, off },
        patch: { goalColumn: goal },
      };
    }
    case "word": {
      let pos = from;
      for (let i = 0; i < n; i++) {
        const next =
          motion.kind === "w"
            ? wordForward(lines, pos)
            : motion.kind === "b"
              ? wordBack(lines, pos)
              : wordEnd(lines, pos);
        // Word helpers clamp at the document edge; stop instead of
        // spinning the remaining (possibly enormous) count there.
        if (next.li === pos.li && next.off === pos.off) break;
        pos = next;
      }
      return {
        target: { kind: "char", pos, inclusive: motion.kind === "e" },
      };
    }
    case "line-start":
      return {
        target: {
          kind: "char",
          pos: { li: from.li, off: 0 },
          inclusive: false,
        },
      };
    case "line-end": {
      // With a count, $ goes to the end of the (count-1)-th line down.
      const li = clampLine(lines, from.li + (n - 1));
      return {
        target: {
          kind: "char",
          pos: { li, off: Math.max(0, lines[li].text.length - 1) },
          inclusive: true,
        },
      };
    }
    case "first-nonblank":
      return {
        target: {
          kind: "char",
          pos: { li: from.li, off: firstNonBlank(line) },
          inclusive: false,
        },
      };
    case "doc": {
      const li =
        count !== null
          ? clampLine(lines, count - 1)
          : motion.edge === "first"
            ? 0
            : lines.length - 1;
      return { target: { kind: "line", li, off: firstNonBlank(lines[li]) } };
    }
    case "find": {
      const patch: Partial<VimState> = {
        lastFind: { kind: motion.kind, char: motion.char },
      };
      const target = resolveFind(
        lines,
        from,
        motion.kind,
        motion.char,
        n,
        false,
      );
      return { target, patch };
    }
    case "repeat-find": {
      const last = state.lastFind;
      if (!last) return { target: null };
      const kind = motion.reverse ? REVERSED[last.kind] : last.kind;
      return {
        target: resolveFind(lines, from, kind, last.char, n, kind === last.kind),
      };
    }
  }
}
