import { Editor, Element, Node, Path, type Point } from "slate";
import type { LinePos } from "./types";

/**
 * One vim "line". For most blocks (paragraph, heading, list-item paragraph)
 * a lowest block is exactly one line with `start === 0`. Code blocks are a
 * single Slate block whose text contains embedded newlines, so they expand
 * into several lines sharing a `blockPath` with increasing `start` offsets.
 */
export interface Line {
  blockPath: Path;
  /** Offset of this line's first character within the block's text. */
  start: number;
  text: string;
}

/** Snapshot of the document as vim lines. O(doc) per keystroke; cheap. */
export function getLines(editor: Editor): Line[] {
  const lines: Line[] = [];
  for (const [node, path] of Editor.nodes(editor, {
    at: [],
    match: (n) => Element.isElement(n) && Editor.isBlock(editor, n),
    mode: "lowest",
  })) {
    const text = Editor.isVoid(editor, node as Element)
      ? ""
      : Node.string(node);
    let start = 0;
    for (const part of text.split("\n")) {
      lines.push({ blockPath: path, start, text: part });
      start += part.length + 1;
    }
  }
  return lines;
}

/** Character offset of `point` within the text of the block at `blockPath`. */
function blockOffsetOfPoint(
  editor: Editor,
  blockPath: Path,
  point: Point,
): number {
  const start = Editor.start(editor, blockPath);
  return Editor.string(editor, { anchor: start, focus: point }).length;
}

/** Map a Slate point to vim (line, column) coordinates. */
export function posOfPoint(
  editor: Editor,
  lines: Line[],
  point: Point,
): LinePos {
  let blockOffset: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inBlock =
      Path.equals(line.blockPath, point.path) ||
      Path.isAncestor(line.blockPath, point.path);
    if (!inBlock) continue;
    blockOffset ??= blockOffsetOfPoint(editor, line.blockPath, point);
    if (
      blockOffset >= line.start &&
      blockOffset <= line.start + line.text.length
    ) {
      return { li: i, off: blockOffset - line.start };
    }
  }
  return { li: 0, off: 0 };
}

/**
 * Map a raw character offset within a block's text (newlines included) to a
 * Slate point, walking the block's text leaves (handles mark-split leaves
 * and skips zero-width inline voids).
 */
export function pointAtBlockOffset(
  editor: Editor,
  blockPath: Path,
  target: number,
): Point {
  const [blockNode] = Editor.node(editor, blockPath);
  let cum = 0;
  let last: Point = Editor.start(editor, blockPath);
  for (const [textNode, textPath] of Node.texts(blockNode)) {
    const abs = blockPath.concat(textPath);
    const len = textNode.text.length;
    if (target <= cum + len && len > 0) {
      return { path: abs, offset: target - cum };
    }
    if (len > 0 || target === cum) {
      last = { path: abs, offset: len };
    }
    cum += len;
  }
  return last;
}

/**
 * Map vim (line, column) coordinates to a Slate point. `off` is clamped to
 * the line length.
 */
export function pointOfPos(
  editor: Editor,
  lines: Line[],
  pos: LinePos,
): Point {
  const line = lines[Math.max(0, Math.min(pos.li, lines.length - 1))];
  const target = line.start + Math.max(0, Math.min(pos.off, line.text.length));
  return pointAtBlockOffset(editor, line.blockPath, target);
}

/**
 * Clamp a column to the normal-mode invariant: the caret sits ON a
 * character, so `off <= len - 1` (0 on an empty line). Insert mode may sit
 * after the last character.
 */
export function clampCol(line: Line, off: number, mode: "normal" | "insert") {
  const max =
    mode === "insert" ? line.text.length : Math.max(0, line.text.length - 1);
  return Math.max(0, Math.min(off, max));
}

/** First non-whitespace column of a line (0 for blank lines). */
export function firstNonBlank(line: Line): number {
  const match = line.text.match(/\S/);
  return match?.index ?? 0;
}
