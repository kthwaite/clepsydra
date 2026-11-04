/**
 * The flat outline model: what each edit should do, stated over lines. It never
 * touches Slate paths, so it cannot inherit a tree-transform mistake.
 *
 * Intended behaviour comes from the docstrings in withOutliner.ts and
 * listContinuation.ts, and from the reading-order rule: an edit that does not
 * ask to reorder must not reorder.
 */
import type { CaretInfo, Line } from "./harness";

export interface Flat {
  depth: number;
  kind: string;
  text: string;
  checked: boolean | null;
}

const isLead = (l: Line) => l.kind === "b" || l.kind === "n";

export const flat = (ls: Line[]): Flat[] =>
  ls.map(({ depth, kind, text, checked }) => ({ depth, kind, text, checked }));

/** The lead line of the item holding line `i`, for depth > 0 text blocks. */
function leadOf(ls: Line[], i: number): number | null {
  const l = ls[i];
  if (l.listKey === null) {
    // A blockquote line inside an item belongs to that item.
    if (l.depth === 0) return null;
    for (let j = i - 1; j >= 0; j--) {
      if (ls[j].depth < l.depth && isLead(ls[j])) return j;
    }
    return null;
  }
  for (let j = i; j >= 0; j--) {
    if (ls[j].depth === l.depth && isLead(ls[j]) && ls[j].listKey === l.listKey)
      return j;
    if (ls[j].depth < l.depth) return null;
  }
  return null;
}

/** End (exclusive) of the item starting at lead line `lead`. */
function itemEnd(ls: Line[], lead: number): number {
  const d = ls[lead].depth;
  for (let j = lead + 1; j < ls.length; j++) {
    if (ls[j].depth < d) return j;
    if (ls[j].depth === d && (isLead(ls[j]) || ls[j].listKey === null))
      return j;
  }
  return ls.length;
}

function prevSibling(ls: Line[], lead: number): number | null {
  const l = ls[lead];
  for (let j = lead - 1; j >= 0; j--) {
    if (ls[j].depth < l.depth) return null;
    if (ls[j].depth === l.depth && isLead(ls[j])) {
      return ls[j].listKey === l.listKey ? j : null;
    }
  }
  return null;
}

function nextSibling(ls: Line[], lead: number): number | null {
  const e = itemEnd(ls, lead);
  if (e < ls.length && isLead(ls[e]) && ls[e].listKey === ls[lead].listKey) {
    return e;
  }
  return null;
}

/** The enclosing item's lead line for a nested item. */
function parentLead(ls: Line[], lead: number): number | null {
  const d = ls[lead].depth;
  for (let j = lead - 1; j >= 0; j--) {
    if (ls[j].depth < d && isLead(ls[j])) return j;
  }
  return null;
}

function shift(ls: Flat[], from: number, to: number, by: number): Flat[] {
  return ls.map((l, i) =>
    i >= from && i < to ? { ...l, depth: l.depth + by } : l,
  );
}

/** Wildcard kind: oracle does not state the list type of this line. */
export const ANY = "*";

export function sameOutline(a: Flat[], expected: Flat[]): boolean {
  if (a.length !== expected.length) return false;
  return a.every((l, i) => {
    const e = expected[i];
    return (
      l.depth === e.depth &&
      (e.kind === ANY || l.kind === e.kind) &&
      l.text === e.text &&
      l.checked === e.checked
    );
  });
}

/** The item at `lead` leaves its list: lead becomes a paragraph, kids rise. */
function lifted(ls: Line[], f: Flat[], lead: number, text?: string): Flat[] {
  const end = itemEnd(ls, lead);
  const d = ls[lead].depth;
  const out = shift(f, lead, end, -1);
  out[lead] = {
    ...out[lead],
    kind: "p",
    checked: null,
    ...(text === undefined ? {} : { text }),
  };
  for (let i = lead + 1; i < end; i++) {
    if (ls[i].depth === d && out[i].kind === "paragraph") {
      out[i] = { ...out[i], kind: "p" };
    }
    // A blockquote line directly in the item counts two levels inside it.
    if (ls[i].depth === d + 1 && ls[i].listKey === null) {
      out[i] = { ...out[i], depth: d - 1 };
    }
  }
  return out;
}

function outdented(ls: Line[], f: Flat[], lead: number): Flat[] {
  const end = itemEnd(ls, lead);
  const out = shift(f, lead, end, -1);
  const parent = parentLead(ls, lead);
  if (parent !== null) out[lead] = { ...out[lead], kind: ls[parent].kind };
  return out;
}

/**
 * The expected outline after `op`, or null where the model states nothing.
 * Only called for a collapsed selection on a resolved line.
 */
export function expectedOutline(
  k: string,
  ls: Line[],
  caret: CaretInfo,
): Flat[] | null {
  const f = flat(ls);
  const lead = leadOf(ls, caret.lineIndex);
  const onLead = lead === caret.lineIndex;
  const line = ls[caret.lineIndex];
  const atStart = caret.lineOffset === 0;
  const atEnd = caret.lineOffset === line.text.length;

  switch (k) {
    case "tab": {
      if (lead === null) return f;
      const prev = prevSibling(ls, lead);
      if (prev === null) return f;
      const out = shift(f, lead, itemEnd(ls, lead), 1);
      // Existing nested list wins the type; else it inherits the parent list.
      out[lead] = { ...out[lead], kind: ANY };
      return out;
    }
    case "untab":
      if (lead === null || !ls[lead].nested) return f;
      return outdented(ls, f, lead);
    case "up": {
      if (lead === null) return null;
      const prev = prevSibling(ls, lead);
      if (prev === null) return f;
      const end = itemEnd(ls, lead);
      return [...f.slice(0, prev), ...f.slice(lead, end), ...f.slice(prev, lead), ...f.slice(end)];
    }
    case "down": {
      if (lead === null) return null;
      const next = nextSibling(ls, lead);
      if (next === null) return f;
      const nextEnd = itemEnd(ls, next);
      return [...f.slice(0, lead), ...f.slice(next, nextEnd), ...f.slice(lead, next), ...f.slice(nextEnd)];
    }
    case "toggle": {
      if (lead === null) return f;
      const cur = f[lead].checked;
      const out = [...f];
      out[lead] = { ...out[lead], checked: cur === false };
      return out;
    }
    case "enter": {
      if (lead === null || !onLead) return null;
      const end = itemEnd(ls, lead);
      if (line.text.trim() === "") {
        if (ls[lead].nested) return outdented(ls, f, lead);
        // Exit in place: the list splits around the new paragraph, as Backspace
        // does; nothing below it is lost or jumps above it.
        return lifted(ls, f, lead);
      }
      if (atEnd) {
        const fresh: Flat = {
          depth: line.depth,
          kind: line.kind,
          text: "",
          checked: line.checked === null ? null : false,
        };
        return [...f.slice(0, end), fresh, ...f.slice(end)];
      }
      return null;
    }
    case "bs": {
      if (lead === null || !onLead || !atStart) return null;
      if (ls[lead].nested) return outdented(ls, f, lead);
      // joinAdjacentLists owns the case with a preceding same-type list.
      const before = lead > 0 ? ls[lead - 1] : null;
      if (
        before &&
        before.depth >= ls[lead].depth &&
        before.listKey !== null &&
        prevSibling(ls, lead) === null
      ) {
        return null;
      }
      return lifted(ls, f, lead);
    }
    default:
      return null;
  }
}

/**
 * What an edit should do to the reading-order string (all text, in document
 * order, voids as one char). Null: the model states nothing here.
 */
export function expectedReading(
  k: string,
  pre: string,
  caret: CaretInfo | null,
  selected: [number, number] | null,
  ch?: string,
): string | null {
  if (selected && (k === "bs" || k === "del")) {
    return pre.slice(0, selected[0]) + pre.slice(selected[1]);
  }
  if (selected && k === "type") {
    return pre.slice(0, selected[0]) + ch + pre.slice(selected[1]);
  }
  if (selected && (k === "enter" || k === "soft")) {
    return pre.slice(0, selected[0]) + pre.slice(selected[1]);
  }
  if (!caret) return null;
  switch (k) {
    case "enter":
    case "soft":
    case "tab":
    case "untab":
    case "toggle":
      return pre;
    case "type":
      return (
        pre.slice(0, caret.readingIndex) + ch + pre.slice(caret.readingIndex)
      );
    default:
      return null;
  }
}
