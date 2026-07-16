import type { Editor } from "slate";
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
import { firstNonBlank, getLines, type Line } from "./lines";
import { resolveMotion } from "./motions";
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
import type { VimState } from "./types";
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
        target = wordEnd(lines, target);
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

function run(
  editor: Editor,
  state: VimState,
  command: Command,
): Partial<VimState> {
  switch (command.t) {
    case "move": {
      const lines = getLines(editor);
      const from = cursorPos(editor, lines);
      const res = resolveMotion(
        lines,
        from,
        state,
        command.motion,
        command.count,
      );
      const patch: Partial<VimState> = res.patch ?? {};
      if (!res.target) return patch;
      const pos =
        res.target.kind === "char"
          ? res.target.pos
          : { li: res.target.li, off: res.target.off };
      selectPos(editor, "normal", pos);
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
    // Text objects and visual mode land in the next phase.
    case "op-object":
    case "visual-op":
    case "visual-object":
    case "enter-visual":
      return {};
  }
}
