import { type Editor, Transforms } from "slate";
import type { Command, Motion, Operator } from "../core/ast";
import {
  deleteChar,
  enterInsert,
  escapeToNormal,
  joinLines,
  replaceChar,
  toggleCase,
  undoRedo,
} from "./actions";
import {
  clampCol,
  firstNonBlank,
  getLines,
  type Line,
  pointOfPos,
} from "./lines";
import { resolveMotion } from "./motions";
import { resolveTextObject } from "./text-objects";
import {
  applyCharwise,
  captureLinewise,
  changeLineSpan,
  charwiseSpan,
  comparePos,
  cursorPos,
  deleteLineSpan,
  pasteCharwise,
  pasteLinewise,
  selectPos,
} from "./operators";
import type { LinePos, VimState } from "./types";
import { classify, wordEnd } from "./words";

function opLines(
  editor: Editor,
  lines: Line[],
  op: Operator,
  a: number,
  b: number,
): Partial<VimState> {
  const register = captureLinewise(editor, lines, a, b);
  if (op === "y") return { register };
  if (op === "d") {
    deleteLineSpan(editor, lines, a, b);
    return { register };
  }
  changeLineSpan(editor, lines, a, b);
  return { register, mode: "insert" };
}

function opMotion(
  editor: Editor,
  state: VimState,
  op: Operator,
  rawMotion: Motion,
  count: number | null,
): Partial<VimState> {
  const lines = getLines(editor);
  const from = cursorPos(editor, lines);

  // Vim special case: cw on a non-blank changes to the end of the current
  // word run (never eats trailing whitespace, unlike dw); a count takes
  // further word-end steps from there.
  const motion = rawMotion;
  if (op === "c" && motion.t === "word" && motion.kind === "w") {
    const text = lines[from.li].text;
    const ch = text[from.off];
    if (ch !== undefined && !/\s/.test(ch)) {
      const cls = classify(ch);
      let target = { li: from.li, off: from.off };
      while (
        target.off + 1 < text.length &&
        classify(text[target.off + 1]) === cls
      ) {
        target = { li: target.li, off: target.off + 1 };
      }
      for (let n = 1; n < (count ?? 1); n++) {
        const next = wordEnd(lines, target);
        if (next.li === target.li && next.off === target.off) break;
        target = next;
      }
      return applyCharwise(editor, lines, op, {
        start: from,
        end: { li: target.li, off: target.off + 1 },
      });
    }
  }

  const res = resolveMotion(lines, from, state, motion, count);
  const patch: Partial<VimState> = res.patch ?? {};
  if (!res.target) return patch;

  if (res.target.kind === "line") {
    const a = Math.min(from.li, res.target.li);
    const b = Math.max(from.li, res.target.li);
    return { ...patch, ...opLines(editor, lines, op, a, b) };
  }

  let span = charwiseSpan(from, res.target.pos, res.target.inclusive);
  // Vim special case: a forward w used as an operator target never crosses
  // into the next line's leading word when the current line still had
  // non-blank content to operate on (dw at the last word clips at EOL).
  if (
    motion.t === "word" &&
    motion.kind === "w" &&
    span.end.li > span.start.li &&
    comparePos(from, span.start) === 0 &&
    span.end.off <= firstNonBlank(lines[span.end.li]) &&
    lines[span.start.li].text.slice(span.start.off).trim() !== ""
  ) {
    span = {
      start: span.start,
      end: {
        li: span.end.li - 1,
        off: lines[span.end.li - 1].text.length,
      },
    };
  }
  return { ...patch, ...applyCharwise(editor, lines, op, span) };
}

/**
 * Execute a parsed command against the editor. Mutates the document and
 * selection via Transforms and returns a VimState patch (mode changes,
 * register writes, lastFind/goalColumn updates) for the caller to apply.
 */
export function executeCommand(
  editor: Editor,
  state: VimState,
  command: Command,
): Partial<VimState> {
  const patch = run(editor, state, command);
  // Any command that doesn't explicitly manage the goal column clears it.
  return { goalColumn: null, ...patch };
}

interface VisualSpec {
  anchor: LinePos;
  head: LinePos;
  kind: "char" | "line";
}

/**
 * Derive the Slate selection from a visual anchor/head pair. Vim's visual
 * selection includes the characters at BOTH ends, so the trailing end is
 * widened by one; backward selections stay backward so extension keeps
 * working naturally.
 */
function applyVisualSelection(editor: Editor, spec: VisualSpec): void {
  const lines = getLines(editor);
  const { anchor, head, kind } = spec;
  if (kind === "line") {
    const a = Math.min(anchor.li, head.li);
    const b = Math.max(anchor.li, head.li);
    const start = pointOfPos(editor, lines, { li: a, off: 0 });
    const end = pointOfPos(editor, lines, {
      li: b,
      off: lines[b].text.length,
    });
    Transforms.select(
      editor,
      head.li >= anchor.li
        ? { anchor: start, focus: end }
        : { anchor: end, focus: start },
    );
    return;
  }
  const forward = comparePos(anchor, head) <= 0;
  const range = forward
    ? {
        anchor: pointOfPos(editor, lines, anchor),
        focus: pointOfPos(editor, lines, { li: head.li, off: head.off + 1 }),
      }
    : {
        anchor: pointOfPos(editor, lines, {
          li: anchor.li,
          off: anchor.off + 1,
        }),
        focus: pointOfPos(editor, lines, head),
      };
  Transforms.select(editor, range);
}

/** The inclusive charwise span covered by a visual anchor/head pair. */
function visualCharSpan(anchor: LinePos, head: LinePos) {
  return comparePos(anchor, head) <= 0
    ? charwiseSpan(anchor, head, true)
    : charwiseSpan(head, anchor, true);
}

function run(
  editor: Editor,
  state: VimState,
  command: Command,
): Partial<VimState> {
  switch (command.t) {
    case "move": {
      const lines = getLines(editor);
      const inVisual = state.mode === "visual";
      const from =
        inVisual && state.visualHead
          ? state.visualHead
          : cursorPos(editor, lines);
      const res = resolveMotion(
        lines,
        from,
        state,
        command.motion,
        command.count,
      );
      const patch: Partial<VimState> = res.patch ?? {};
      if (!res.target) return patch;
      const raw =
        res.target.kind === "char"
          ? res.target.pos
          : { li: res.target.li, off: res.target.off };
      if (inVisual && state.visualAnchor) {
        const head = {
          li: raw.li,
          off: clampCol(lines[raw.li], raw.off, "normal"),
        };
        applyVisualSelection(editor, {
          anchor: state.visualAnchor,
          head,
          kind: state.visualKind,
        });
        return { ...patch, visualHead: head };
      }
      selectPos(editor, "normal", raw);
      return patch;
    }
    case "op-motion":
      return opMotion(editor, state, command.op, command.motion, command.count);
    case "op-line": {
      const lines = getLines(editor);
      const from = cursorPos(editor, lines);
      const n = command.count ?? 1;
      const b = Math.min(from.li + n - 1, lines.length - 1);
      return opLines(editor, lines, command.op, from.li, b);
    }
    case "enter-insert":
      return enterInsert(editor, command.where);
    case "delete-char":
      return deleteChar(editor, command.count);
    case "paste": {
      if (!state.register) return {};
      if (state.register.kind === "line") {
        pasteLinewise(editor, state.register, command.after, command.count);
      } else {
        pasteCharwise(editor, state.register, command.after, command.count);
      }
      return {};
    }
    case "replace-char":
      return replaceChar(editor, command.char, command.count);
    case "toggle-case":
      return toggleCase(editor, command.count);
    case "join":
      return joinLines(editor, command.count);
    case "undo":
      return undoRedo(editor, "undo", command.count);
    case "redo":
      return undoRedo(editor, "redo", command.count);
    case "escape":
      return escapeToNormal(editor, state);
    case "op-object": {
      const lines = getLines(editor);
      const from = cursorPos(editor, lines);
      const span = resolveTextObject(lines, from, command.object);
      if (!span) return {};
      return applyCharwise(editor, lines, command.op, span);
    }
    case "enter-visual": {
      const kind = command.linewise ? "line" : "char";
      if (state.mode === "visual" && state.visualAnchor && state.visualHead) {
        if (kind === state.visualKind) {
          // Same key exits visual mode.
          return escapeToNormal(editor, state);
        }
        applyVisualSelection(editor, {
          anchor: state.visualAnchor,
          head: state.visualHead,
          kind,
        });
        return { visualKind: kind };
      }
      const lines = getLines(editor);
      const from = cursorPos(editor, lines);
      const start = {
        li: from.li,
        off: clampCol(lines[from.li], from.off, "normal"),
      };
      applyVisualSelection(editor, { anchor: start, head: start, kind });
      return {
        mode: "visual",
        visualAnchor: start,
        visualHead: start,
        visualKind: kind,
      };
    }
    case "visual-op": {
      if (!state.visualAnchor || !state.visualHead) return {};
      const lines = getLines(editor);
      const done = {
        mode: "normal" as const,
        visualAnchor: null,
        visualHead: null,
        visualKind: "char" as const,
      };
      if (state.visualKind === "line") {
        const a = Math.min(state.visualAnchor.li, state.visualHead.li);
        const b = Math.max(state.visualAnchor.li, state.visualHead.li);
        const patch = opLines(editor, lines, command.op, a, b);
        if (command.op === "y") {
          selectPos(editor, "normal", { li: a, off: 0 });
        }
        return { ...done, ...patch };
      }
      const span = visualCharSpan(state.visualAnchor, state.visualHead);
      const patch = applyCharwise(editor, lines, command.op, span);
      return { ...done, ...patch };
    }
    case "visual-object": {
      const lines = getLines(editor);
      const from =
        state.visualHead ?? cursorPos(editor, lines);
      const span = resolveTextObject(lines, from, command.object);
      if (!span) return {};
      // Reselect the object (end is exclusive; the head sits on its last char).
      const head =
        span.end.off > 0
          ? { li: span.end.li, off: span.end.off - 1 }
          : { li: span.end.li - 1, off: lines[span.end.li - 1].text.length };
      applyVisualSelection(editor, {
        anchor: span.start,
        head,
        kind: "char",
      });
      return {
        visualAnchor: span.start,
        visualHead: head,
        visualKind: "char",
      };
    }
  }
}
