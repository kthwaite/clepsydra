import type { Line } from "./lines";
import type { LinePos } from "./types";

/**
 * Vim's three character classes: word chars ([A-Za-z0-9_]), other printable
 * chars ("punct"), and whitespace. `w`/`b`/`e` treat word and punct runs as
 * separate words; block/line boundaries act as whitespace, except that an
 * empty line is itself a word stop for `w` and `b`.
 */
type CharClass = "word" | "punct" | "space";

function classify(ch: string): CharClass {
  if (/\s/.test(ch)) return "space";
  if (/[A-Za-z0-9_]/.test(ch)) return "word";
  return "punct";
}

function classAt(lines: Line[], pos: LinePos): CharClass {
  const ch = lines[pos.li]?.text[pos.off];
  // Off the end of a line = the virtual newline = whitespace.
  return ch === undefined ? "space" : classify(ch);
}

/** Step one character forward, crossing line boundaries. Null at doc end. */
function next(lines: Line[], pos: LinePos): LinePos | null {
  if (pos.off < lines[pos.li].text.length) {
    return { li: pos.li, off: pos.off + 1 };
  }
  if (pos.li < lines.length - 1) return { li: pos.li + 1, off: 0 };
  return null;
}

/** Step one character backward, crossing line boundaries. Null at doc start. */
function prev(lines: Line[], pos: LinePos): LinePos | null {
  if (pos.off > 0) return { li: pos.li, off: pos.off - 1 };
  if (pos.li > 0) {
    const line = lines[pos.li - 1];
    return { li: pos.li - 1, off: line.text.length };
  }
  return null;
}

function isEmptyLineStart(lines: Line[], pos: LinePos): boolean {
  return pos.off === 0 && lines[pos.li].text.length === 0;
}

/** `w`: start of the next word (or empty line). Clamps at document end. */
export function wordForward(lines: Line[], from: LinePos): LinePos {
  let pos = from;
  const startClass = classAt(lines, pos);
  // Skip the rest of the current run (if on a non-space char).
  if (startClass !== "space") {
    while (true) {
      const n = next(lines, pos);
      if (!n) return pos;
      pos = n;
      if (classAt(lines, pos) !== startClass) break;
    }
  }
  // Skip whitespace; empty lines (other than the starting one) are stops.
  while (classAt(lines, pos) === "space") {
    if (
      isEmptyLineStart(lines, pos) &&
      (pos.li !== from.li || pos.off !== from.off)
    ) {
      return pos;
    }
    const n = next(lines, pos);
    if (!n) return pos;
    pos = n;
  }
  return pos;
}

/** `b`: start of the previous word (or empty line). Clamps at doc start. */
export function wordBack(lines: Line[], from: LinePos): LinePos {
  let pos = prev(lines, from) ?? from;
  // Skip whitespace backward; empty lines are word stops.
  while (classAt(lines, pos) === "space") {
    if (isEmptyLineStart(lines, pos)) return pos;
    const p = prev(lines, pos);
    if (!p) return pos;
    pos = p;
  }
  // Walk to the start of the current run.
  const cls = classAt(lines, pos);
  while (true) {
    const p = prev(lines, pos);
    if (!p) return pos;
    if (classAt(lines, p) !== cls) return pos;
    pos = p;
  }
}

/** `e`: end of the current/next word. Clamps at document end. */
export function wordEnd(lines: Line[], from: LinePos): LinePos {
  let pos = next(lines, from) ?? from;
  // Skip whitespace (empty lines are not stops for `e`).
  while (classAt(lines, pos) === "space") {
    const n = next(lines, pos);
    if (!n) return pos;
    pos = n;
  }
  // Walk to the end of the current run.
  const cls = classAt(lines, pos);
  while (true) {
    const n = next(lines, pos);
    if (!n) return pos;
    if (classAt(lines, n) !== cls) return pos;
    pos = n;
  }
}

export { classify, next as nextPos, prev as prevPos };
export type { CharClass };
