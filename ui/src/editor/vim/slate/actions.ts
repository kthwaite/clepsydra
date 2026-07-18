import { Editor, Element, Node, Transforms } from "slate";
import type { HistoryEditor } from "slate-history";
import type { InsertWhere } from "../core/ast";
import { advanceGraphemes, nextBoundary, prevBoundary } from "./graphemes";
import {
  firstNonBlank,
  getLines,
  pointAtBlockOffset,
  pointOfPos,
} from "./lines";
import { applyCharwise, cursorPos, selectPos } from "./operators";
import type { VimState } from "./types";

/** `x`: delete `count` graphemes, clamped to the line end. Writes the register. */
export function deleteChar(editor: Editor, count: number): Partial<VimState> {
  const lines = getLines(editor);
  const from = cursorPos(editor, lines);
  const line = lines[from.li];
  if (line.text.length === 0) return {};
  const end = advanceGraphemes(line.text, from.off, count);
  return applyCharwise(editor, lines, "d", {
    start: from,
    end: { li: from.li, off: end },
  });
}

/** `r`: replace `count` graphemes; aborts (like vim) when the line is too short. */
export function replaceChar(
  editor: Editor,
  char: string,
  count: number,
): Partial<VimState> {
  const lines = getLines(editor);
  const from = cursorPos(editor, lines);
  const line = lines[from.li];
  let end = from.off;
  for (let i = 0; i < count; i++) {
    if (end >= line.text.length) return {};
    end = nextBoundary(line.text, end);
  }
  Transforms.insertText(editor, char.repeat(count), {
    at: {
      anchor: pointOfPos(editor, lines, from),
      focus: pointOfPos(editor, lines, { li: from.li, off: end }),
    },
  });
  // The replacement chars are single code units; land on the last one.
  selectPos(editor, "normal", { li: from.li, off: from.off + count - 1 });
  return {};
}

/** `~`: toggle case of `count` graphemes and advance past them. */
export function toggleCase(editor: Editor, count: number): Partial<VimState> {
  const lines = getLines(editor);
  const from = cursorPos(editor, lines);
  const line = lines[from.li];
  if (line.text.length === 0) return {};
  const end = advanceGraphemes(line.text, from.off, count);
  const swapped = [...line.text.slice(from.off, end)]
    .map((ch) => {
      const lower = ch.toLowerCase();
      const upper = ch.toUpperCase();
      return ch === lower ? upper : lower;
    })
    .join("");
  Transforms.insertText(editor, swapped, {
    at: {
      anchor: pointOfPos(editor, lines, from),
      focus: pointOfPos(editor, lines, { li: from.li, off: end }),
    },
  });
  selectPos(editor, "normal", { li: from.li, off: end });
  return {};
}

/** `J`: join `max(count, 2)` lines with single-space separators. */
export function joinLines(editor: Editor, count: number): Partial<VimState> {
  const joins = Math.max(count, 2) - 1;
  for (let i = 0; i < joins; i++) {
    const lines = getLines(editor);
    const from = cursorPos(editor, lines);
    if (from.li >= lines.length - 1) break;
    const cur = lines[from.li];
    const next = lines[from.li + 1];
    const lead = next.text.match(/\S/)?.index ?? next.text.length;
    Transforms.delete(editor, {
      at: {
        anchor: pointOfPos(editor, lines, {
          li: from.li,
          off: cur.text.length,
        }),
        focus: pointOfPos(editor, lines, { li: from.li + 1, off: lead }),
      },
    });
    const needSpace =
      cur.text.length > 0 &&
      !cur.text.endsWith(" ") &&
      next.text.trim().length > 0;
    if (needSpace) {
      const now = getLines(editor);
      Transforms.insertText(editor, " ", {
        at: pointOfPos(editor, now, { li: from.li, off: cur.text.length }),
      });
    }
    selectPos(editor, "normal", { li: from.li, off: cur.text.length });
  }
  return {};
}

function isCodeBlock(editor: Editor, path: number[]): boolean {
  const node = Node.get(editor, path);
  return Element.isElement(node) && node.type === "code-block";
}

/**
 * `o`/`O`: open a line. Normal blocks go through `editor.insertBreak()` so
 * the host's break behavior (list continuation) applies; code blocks insert
 * a newline within the block instead of splitting it.
 */
function openLine(editor: Editor, below: boolean): void {
  const lines = getLines(editor);
  const from = cursorPos(editor, lines);
  const line = lines[from.li];

  if (isCodeBlock(editor, line.blockPath)) {
    if (below) {
      Transforms.insertText(editor, "\n", {
        at: pointAtBlockOffset(
          editor,
          line.blockPath,
          line.start + line.text.length,
        ),
      });
      selectPos(editor, "insert", { li: from.li + 1, off: 0 });
    } else {
      Transforms.insertText(editor, "\n", {
        at: pointAtBlockOffset(editor, line.blockPath, line.start),
      });
      selectPos(editor, "insert", { li: from.li, off: 0 });
    }
    return;
  }

  if (below) {
    Transforms.select(editor, Editor.end(editor, line.blockPath));
    editor.insertBreak();
    return;
  }
  Transforms.select(editor, Editor.start(editor, line.blockPath));
  editor.insertBreak();
  // The split leaves the caret at the start of the original content; the
  // freshly opened empty line sits just above it.
  const now = getLines(editor);
  const pos = cursorPos(editor, now);
  selectPos(editor, "insert", { li: Math.max(0, pos.li - 1), off: 0 });
}

/** i/a/I/A/o/O entry into insert mode. */
export function enterInsert(
  editor: Editor,
  where: InsertWhere,
): Partial<VimState> {
  if (where === "open-below" || where === "open-above") {
    openLine(editor, where === "open-below");
    return { mode: "insert" };
  }
  const lines = getLines(editor);
  const from = cursorPos(editor, lines);
  const line = lines[from.li];
  const off =
    where === "here"
      ? from.off
      : where === "after"
        ? nextBoundary(line.text, from.off)
        : where === "first-nonblank"
          ? firstNonBlank(line)
          : line.text.length;
  selectPos(editor, "insert", { li: from.li, off });
  return { mode: "insert" };
}

/** Escape to normal mode (insert steps the caret one left, like vim). */
export function escapeToNormal(
  editor: Editor,
  state: VimState,
): Partial<VimState> {
  if (state.mode === "visual" && state.visualHead) {
    selectPos(editor, "normal", state.visualHead);
  } else {
    const lines = getLines(editor);
    const from = cursorPos(editor, lines);
    selectPos(editor, "normal", {
      li: from.li,
      off:
        state.mode === "insert"
          ? prevBoundary(lines[from.li].text, from.off)
          : from.off,
    });
  }
  return {
    mode: "normal",
    visualAnchor: null,
    visualHead: null,
    visualKind: "char",
  };
}

export function undoRedo(
  editor: Editor,
  kind: "undo" | "redo",
  count: number,
): Partial<VimState> {
  const history = editor as Editor & Partial<HistoryEditor>;
  const step = kind === "undo" ? history.undo : history.redo;
  if (!step) return {};
  for (let i = 0; i < count; i++) {
    const stack =
      kind === "undo" ? history.history?.undos : history.history?.redos;
    if (!stack || stack.length === 0) break;
    step.call(history);
  }
  const lines = getLines(editor);
  selectPos(editor, "normal", cursorPos(editor, lines));
  return {};
}
