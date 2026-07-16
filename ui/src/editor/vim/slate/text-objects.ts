import type { TextObject, TextObjectKind } from "../core/ast";
import type { Line } from "./lines";
import type { CharwiseSpan } from "./operators";
import type { LinePos } from "./types";
import { classify } from "./words";

const BRACKET_PAIRS: Partial<Record<TextObjectKind, [string, string]>> = {
  "(": ["(", ")"],
  "[": ["[", "]"],
  "{": ["{", "}"],
  "<": ["<", ">"],
};

/** iw/aw: the character run under the cursor (current line only). */
function wordObject(
  lines: Line[],
  from: LinePos,
  around: boolean,
): CharwiseSpan | null {
  const text = lines[from.li].text;
  if (text.length === 0) return null;
  const off = Math.min(from.off, text.length - 1);
  const cls = classify(text[off]);
  let start = off;
  let end = off + 1;
  while (start > 0 && classify(text[start - 1]) === cls) start--;
  while (end < text.length && classify(text[end]) === cls) end++;
  if (around && cls !== "space") {
    // aw takes trailing whitespace, or leading when there is none trailing.
    let extended = end;
    while (extended < text.length && classify(text[extended]) === "space") {
      extended++;
    }
    if (extended > end) {
      end = extended;
    } else {
      while (start > 0 && classify(text[start - 1]) === "space") start--;
    }
  } else if (around) {
    // Cursor on whitespace: aw is the whitespace plus the following word.
    const cls2 = end < text.length ? classify(text[end]) : null;
    while (end < text.length && classify(text[end]) === cls2) end++;
  }
  return {
    start: { li: from.li, off: start },
    end: { li: from.li, off: end },
  };
}

/** i"/a" etc.: quote pairs on the current line (vim's rule). */
function quoteObject(
  lines: Line[],
  from: LinePos,
  quote: string,
  around: boolean,
): CharwiseSpan | null {
  const text = lines[from.li].text;
  const positions: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === quote) positions.push(i);
  }
  // Pair quotes up from the line start; take the pair containing the
  // cursor, or the next pair after it.
  for (let i = 0; i + 1 < positions.length; i += 2) {
    const open = positions[i];
    const close = positions[i + 1];
    if (from.off <= close) {
      return around
        ? {
            start: { li: from.li, off: open },
            end: { li: from.li, off: close + 1 },
          }
        : {
            start: { li: from.li, off: open + 1 },
            end: { li: from.li, off: close },
          };
    }
  }
  return null;
}

/** i(/a( etc.: nesting-aware bracket pairs, searched across lines. */
function bracketObject(
  lines: Line[],
  from: LinePos,
  kind: TextObjectKind,
  around: boolean,
): CharwiseSpan | null {
  const pair = BRACKET_PAIRS[kind];
  if (!pair) return null;
  const [open, close] = pair;
  // Flatten to one string with \n line separators for cross-line scans.
  const flat = lines.map((l) => l.text).join("\n");
  const starts: number[] = [];
  let cum = 0;
  for (const line of lines) {
    starts.push(cum);
    cum += line.text.length + 1;
  }
  const globalOf = (pos: LinePos) => starts[pos.li] + pos.off;
  const posOf = (idx: number): LinePos => {
    let li = starts.length - 1;
    while (li > 0 && starts[li] > idx) li--;
    return { li, off: idx - starts[li] };
  };

  const cursor = globalOf(from);
  let openIdx: number | null = null;
  if (flat[cursor] === open) {
    openIdx = cursor;
  } else {
    // When on a closer, match ITS opener; otherwise find the innermost
    // unmatched opener before the cursor.
    let depth = 0;
    const scanFrom = flat[cursor] === close ? cursor - 1 : cursor;
    for (let i = scanFrom; i >= 0; i--) {
      const ch = flat[i];
      if (ch === close) depth++;
      else if (ch === open) {
        if (depth === 0) {
          openIdx = i;
          break;
        }
        depth--;
      }
    }
  }
  if (openIdx === null) return null;

  let closeIdx: number | null = null;
  let depth = 0;
  for (let i = openIdx + 1; i < flat.length; i++) {
    const ch = flat[i];
    if (ch === open) depth++;
    else if (ch === close) {
      if (depth === 0) {
        closeIdx = i;
        break;
      }
      depth--;
    }
  }
  if (closeIdx === null) return null;

  return around
    ? { start: posOf(openIdx), end: posOf(closeIdx + 1) }
    : { start: posOf(openIdx + 1), end: posOf(closeIdx) };
}

/**
 * Resolve a text object at the cursor to a charwise span (end-exclusive).
 * Null when there is no enclosing object (vim beeps, command no-ops).
 */
export function resolveTextObject(
  lines: Line[],
  from: LinePos,
  object: TextObject,
): CharwiseSpan | null {
  if (object.kind === "w") return wordObject(lines, from, object.around);
  if (object.kind === '"' || object.kind === "'" || object.kind === "`") {
    return quoteObject(lines, from, object.kind, object.around);
  }
  return bracketObject(lines, from, object.kind, object.around);
}
