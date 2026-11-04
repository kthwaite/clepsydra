import { Editor, Element, Node, Path, Point, Transforms } from "slate";
import type { HistoryEditor } from "slate-history";
import { makeParagraph } from "#/editor/schema/elements/paragraph";
import type { ListItemElement } from "#/editor/schema/types";
import type { InsertWhere } from "../core/ast";
import { advanceGraphemes, nextBoundary, prevBoundary } from "./graphemes";
import {
  firstNonBlank,
  getLines,
  type Line,
  pointAtBlockOffset,
  pointOfPos,
} from "./lines";
import {
  applyCharwise,
  cursorPos,
  deleteAcrossBlocks,
  selectPos,
} from "./operators";
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

/** Replace the chars of one grapheme, leaving any wikilink beside it alone. */
function replaceGrapheme(
  editor: Editor,
  lines: Line[],
  li: number,
  off: number,
  text: string,
): void {
  const end = nextBoundary(lines[li].text, off);
  Transforms.insertText(editor, text, {
    at: {
      anchor: pointOfPos(editor, lines, { li, off }, "after"),
      focus: pointOfPos(editor, lines, { li, off: end }, "before"),
    },
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
  const starts: number[] = [];
  let end = from.off;
  for (let i = 0; i < count; i++) {
    if (end >= line.text.length) return {};
    starts.push(end);
    end = nextBoundary(line.text, end);
  }
  // One at a time so a link or mark between graphemes survives. Right to left
  // keeps the earlier columns valid.
  for (const off of starts.reverse()) {
    replaceGrapheme(editor, lines, from.li, off, char);
  }
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
  const starts: number[] = [];
  for (let off = from.off; off < end; off = nextBoundary(line.text, off)) {
    starts.push(off);
  }
  // One at a time, right to left, as in replaceChar.
  for (const off of starts.reverse()) {
    const grapheme = line.text.slice(off, nextBoundary(line.text, off));
    const swapped = [...grapheme]
      .map((ch) => {
        const lower = ch.toLowerCase();
        const upper = ch.toUpperCase();
        return ch === lower ? upper : lower;
      })
      .join("");
    replaceGrapheme(editor, lines, from.li, off, swapped);
  }
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
    // Spaces after a leading link are text, not indent.
    const leadingLink = !Point.equals(
      pointOfPos(editor, lines, { li: from.li + 1, off: 0 }, "before"),
      pointOfPos(editor, lines, { li: from.li + 1, off: 0 }, "after"),
    );
    const lead = leadingLink
      ? 0
      : (next.text.match(/\S/)?.index ?? next.text.length);
    // Cut only the break and the indent: a wikilink ending the current line or
    // starting the next sits outside this range.
    const anchor = pointOfPos(
      editor,
      lines,
      { li: from.li, off: cur.text.length },
      "after",
    );
    const focus = pointOfPos(
      editor,
      lines,
      { li: from.li + 1, off: lead },
      "before",
    );
    // A link counts as content, though it adds no columns.
    const curHasContent =
      cur.text.length > 0 ||
      !Point.equals(
        anchor,
        pointOfPos(editor, lines, { li: from.li, off: 0 }, "before"),
      );
    const nextHasContent =
      next.text.trim().length > 0 ||
      !Point.equals(
        focus,
        pointOfPos(
          editor,
          lines,
          { li: from.li + 1, off: next.text.length },
          "after",
        ),
      );
    const endsInSpace =
      cur.text.endsWith(" ") &&
      Point.equals(
        anchor,
        pointOfPos(
          editor,
          lines,
          { li: from.li, off: cur.text.length },
          "before",
        ),
      );
    const space = curHasContent && !endsInSpace && nextHasContent;
    // The space goes in first: the join point has no column of its own when a
    // link sits on either side of it.
    const focusRef = Editor.pointRef(editor, focus);
    if (space) Transforms.insertText(editor, " ", { at: anchor });
    const start = { ...anchor, offset: anchor.offset + (space ? 1 : 0) };
    const end = focusRef.unref();
    // An empty current line has nothing before the break, which Slate would
    // read as a range hanging over into the next line and shrink away.
    if (end) {
      deleteAcrossBlocks(editor, { anchor: start, focus: end }, true);
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
 * The item whose lead line is `blockPath`, when that line shows nothing: no text
 * but whitespace, no inline void. Enter on such an item leaves the list.
 */
function emptyItemOf(editor: Editor, blockPath: Path): Path | null {
  if (blockPath[blockPath.length - 1] !== 0 || blockPath.length < 2)
    return null;
  const itemPath = Path.parent(blockPath);
  const item = Node.get(editor, itemPath);
  if (!Element.isElement(item) || item.type !== "list-item") return null;
  const block = Node.get(editor, blockPath) as Element;
  const blank =
    Node.string(block).trim() === "" &&
    !block.children.some((child) => Element.isElement(child));
  return blank ? itemPath : null;
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

  const emptyItem = emptyItemOf(editor, line.blockPath);
  if (emptyItem) {
    // Enter here would leave the list; these commands only open a line.
    const { checked } = Node.get(editor, emptyItem) as ListItemElement;
    const at = below ? Path.next(emptyItem) : emptyItem;
    const fresh: ListItemElement = {
      type: "list-item",
      children: [makeParagraph({})],
      ...(checked === undefined || checked === null ? {} : { checked: false }),
    };
    Transforms.insertNodes(editor, fresh, { at });
    Transforms.select(editor, Editor.start(editor, at));
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
  // Typing goes right before the caret's char, except `a`: right after it.
  selectPos(
    editor,
    "insert",
    { li: from.li, off },
    where === "after" ? "before" : "after",
  );
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
