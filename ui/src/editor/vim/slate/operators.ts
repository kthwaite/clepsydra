import type { Descendant, Range } from "slate";
import { Editor, Element, Node, Path, Transforms } from "slate";
import type { Operator } from "../core/ast";
import { nextBoundary } from "./graphemes";
import {
  clampCol,
  firstNonBlank,
  getLines,
  type Line,
  pointAtBlockOffset,
  pointOfPos,
  posOfPoint,
} from "./lines";
import type { LinePos, Register, VimState } from "./types";

export function comparePos(a: LinePos, b: LinePos): number {
  return a.li - b.li || a.off - b.off;
}

/** Collapse the selection at (li, off), clamped to the mode's column rule. */
export function selectPos(
  editor: Editor,
  mode: "normal" | "insert",
  pos: LinePos,
): void {
  const lines = getLines(editor);
  const li = Math.max(0, Math.min(pos.li, lines.length - 1));
  const off = clampCol(lines[li], pos.off, mode);
  Transforms.select(editor, pointOfPos(editor, lines, { li, off }));
}

/** Current cursor head as a (line, column) position. */
export function cursorPos(editor: Editor, lines: Line[]): LinePos {
  const point = editor.selection?.focus;
  if (!point) return { li: 0, off: 0 };
  return posOfPoint(editor, lines, point);
}

// --- Register handling ---

/** Cloned register content must not carry block identities into pastes. */
function stripBlockIds(nodes: Descendant[]): Descendant[] {
  for (const node of nodes) {
    if (Element.isElement(node)) {
      if ("blockId" in node) delete node.blockId;
      stripBlockIds(node.children as Descendant[]);
    }
  }
  return nodes;
}

function captureCharwise(editor: Editor, range: Range): Register {
  return {
    kind: "char",
    fragment: stripBlockIds(structuredClone(Editor.fragment(editor, range))),
  };
}

function isListItem(node: Node): node is Element {
  return Element.isElement(node) && node.type === "list-item";
}

/**
 * A line on a list-item's primary paragraph stands for the whole item,
 * nested lists included. (Canonical shape puts the paragraph at index 0.)
 */
function listItemOf(editor: Editor, blockPath: Path): Path | null {
  if (blockPath.length === 0 || blockPath[blockPath.length - 1] !== 0) {
    return null;
  }
  const parentPath = Path.parent(blockPath);
  if (parentPath.length === 0) return null;
  const parent = Node.get(editor, parentPath);
  return isListItem(parent) ? parentPath : null;
}

/**
 * The node cloned into a linewise register for a given line: the enclosing
 * list-item (with any nested lists) when the line is the item's primary
 * paragraph, otherwise the block.
 */
function registerUnitPath(editor: Editor, blockPath: Path): Path {
  return listItemOf(editor, blockPath) ?? blockPath;
}

/**
 * The path removed when deleting a whole line: the owning list-item when
 * the line is its primary paragraph, then up through wrappers (list-item,
 * list, blockquote) that would be left empty.
 */
function deleteUnitPath(editor: Editor, blockPath: Path): Path {
  let path = listItemOf(editor, blockPath) ?? blockPath;
  while (path.length > 1) {
    const parentPath = Path.parent(path);
    const parent = Node.get(editor, parentPath);
    if (
      Element.isElement(parent) &&
      (parent.type === "list-item" ||
        parent.type === "bulleted-list" ||
        parent.type === "numbered-list" ||
        parent.type === "blockquote") &&
      parent.children.length === 1
    ) {
      path = parentPath;
      continue;
    }
    break;
  }
  return path;
}

// --- Line spans ---

interface LineGroup {
  blockPath: Path;
  /** Indices into `lines` (inclusive). */
  first: number;
  last: number;
  /** True when the group covers every virtual line of its block. */
  whole: boolean;
}

function groupSpan(lines: Line[], a: number, b: number): LineGroup[] {
  const groups: LineGroup[] = [];
  for (let i = a; i <= b; i++) {
    const line = lines[i];
    const prev = groups[groups.length - 1];
    if (prev && Path.equals(prev.blockPath, line.blockPath)) {
      prev.last = i;
    } else {
      groups.push({
        blockPath: line.blockPath,
        first: i,
        last: i,
        whole: false,
      });
    }
  }
  for (const group of groups) {
    const blockLines = lines.filter((l) =>
      Path.equals(l.blockPath, group.blockPath),
    ).length;
    group.whole = group.last - group.first + 1 === blockLines;
  }
  return groups;
}

/** Build a linewise register from lines [a..b]. */
export function captureLinewise(
  editor: Editor,
  lines: Line[],
  a: number,
  b: number,
): Register {
  const fragment: Descendant[] = [];
  const captured: Path[] = [];
  for (const group of groupSpan(lines, a, b)) {
    if (group.whole) {
      const unit = registerUnitPath(editor, group.blockPath);
      // Groups run in document order, so a unit that subsumed later lines
      // (an item with nested lists) is captured once, not per line.
      if (
        captured.some((c) => Path.equals(c, unit) || Path.isAncestor(c, unit))
      ) {
        continue;
      }
      captured.push(unit);
      fragment.push(structuredClone(Node.get(editor, unit)) as Descendant);
    } else {
      // Partial code block: synthesize a code block from the covered lines.
      const block = Node.get(editor, group.blockPath);
      const text = lines
        .slice(group.first, group.last + 1)
        .map((l) => l.text)
        .join("\n");
      fragment.push({
        ...(structuredClone(block) as Element),
        children: [{ text }],
      } as Descendant);
    }
  }
  return { kind: "line", fragment: stripBlockIds(fragment) };
}

/** Remove lines [a..b] wholesale (vim dd). Repairs an emptied editor. */
export function deleteLineSpan(
  editor: Editor,
  lines: Line[],
  a: number,
  b: number,
): void {
  const groups = groupSpan(lines, a, b);
  let survivors = 0;
  Editor.withoutNormalizing(editor, () => {
    for (const group of [...groups].reverse()) {
      if (group.whole) {
        Transforms.removeNodes(editor, {
          at: deleteUnitPath(editor, group.blockPath),
        });
        continue;
      }
      // Partial code block: delete the covered text including one adjacent
      // newline (trailing when it exists, else leading).
      const start = lines[group.first].start;
      const end = lines[group.last].start + lines[group.last].text.length;
      const blockLen = Node.string(Node.get(editor, group.blockPath)).length;
      const range =
        end < blockLen
          ? { start, end: end + 1 }
          : { start: Math.max(0, start - 1), end };
      Transforms.delete(editor, {
        at: {
          anchor: pointAtBlockOffset(editor, group.blockPath, range.start),
          focus: pointAtBlockOffset(editor, group.blockPath, range.end),
        },
      });
    }
    if (editor.children.length === 0) {
      Transforms.insertNodes(
        editor,
        { type: "paragraph", children: [{ text: "" }] },
        { at: [0] },
      );
    }
    survivors = getLines(editor).length;
  });
  // The cursor must land on a line that survived the delete. Normalization
  // (which flushes above) can append blocks the delete did not leave behind
  // — e.g. the trailing paragraph after a document-final code block — and
  // those must not count as the line that moved up into the deleted slot.
  const after = getLines(editor);
  const li = Math.min(a, survivors - 1, after.length - 1);
  selectPos(editor, "normal", { li, off: firstNonBlank(after[li]) });
}

/** Clear lines [a..b] into a single empty line and enter insert (vim cc). */
export function changeLineSpan(
  editor: Editor,
  lines: Line[],
  a: number,
  b: number,
): void {
  const anchor = pointOfPos(editor, lines, { li: a, off: 0 });
  const focus = pointOfPos(editor, lines, {
    li: b,
    off: lines[b].text.length,
  });
  Transforms.delete(editor, { at: { anchor, focus } });
  selectPos(editor, "insert", { li: a, off: 0 });
}

// --- Charwise operator ---

export interface CharwiseSpan {
  start: LinePos;
  end: LinePos;
}

/** Sort cursor/target and widen inclusive motions by one grapheme. */
export function charwiseSpan(
  lines: Line[],
  from: LinePos,
  to: LinePos,
  inclusive: boolean,
): CharwiseSpan {
  let start = from;
  let end = to;
  if (comparePos(start, end) > 0) {
    [start, end] = [end, start];
  }
  if (inclusive) {
    end = { li: end.li, off: nextBoundary(lines[end.li].text, end.off) };
  }
  return { start, end };
}

/** Apply d/c/y to a charwise span. Returns the resulting state patch. */
export function applyCharwise(
  editor: Editor,
  lines: Line[],
  op: Operator,
  span: CharwiseSpan,
): Partial<VimState> {
  const { start, end } = span;
  if (comparePos(start, end) >= 0) {
    return op === "c" ? { mode: "insert" } : {};
  }
  const range: Range = {
    anchor: pointOfPos(editor, lines, start),
    focus: pointOfPos(editor, lines, end),
  };
  const register = captureCharwise(editor, range);
  if (op === "y") {
    selectPos(editor, "normal", start);
    return { register };
  }
  if (
    start.li !== end.li &&
    Editor.string(editor, range).length === 0 &&
    lines[start.li].text.length === 0
  ) {
    // Deleting just the line break from an empty line (dw on an empty
    // line): a zero-text cross-block range doesn't merge in Slate, so
    // remove the empty line instead.
    deleteLineSpan(editor, lines, start.li, start.li);
    return op === "c" ? { register, mode: "insert" } : { register };
  }
  Transforms.delete(editor, { at: range });
  selectPos(editor, op === "c" ? "insert" : "normal", start);
  return op === "c" ? { register, mode: "insert" } : { register };
}

// --- Paste ---

/**
 * Paste multiplies register content into the document, so its count gets a
 * far tighter cap than motions (which clamp at document bounds anyway).
 */
const MAX_PASTE_COUNT = 1000;

function isCodeBlock(editor: Editor, blockPath: Path): boolean {
  const node = Node.get(editor, blockPath);
  return Element.isElement(node) && node.type === "code-block";
}

/** Adapt register nodes to the paste context (list vs non-list). */
function adaptNodes(fragment: Descendant[], intoList: boolean): Descendant[] {
  const nodes: Descendant[] = [];
  for (const node of structuredClone(fragment)) {
    if (!intoList && isListItem(node)) {
      nodes.push(...(node.children as Descendant[]));
    } else {
      nodes.push(node);
    }
  }
  return nodes;
}

export function pasteLinewise(
  editor: Editor,
  register: Register,
  after: boolean,
  count: number,
): void {
  const n = Math.min(count, MAX_PASTE_COUNT);
  const lines = getLines(editor);
  const from = cursorPos(editor, lines);
  const line = lines[from.li];

  if (isCodeBlock(editor, line.blockPath)) {
    // Paste as text lines inside the code block.
    const once = register.fragment.map((node) => Node.string(node)).join("\n");
    const parts: string[] = [];
    for (let i = 0; i < n; i++) parts.push(once);
    const text = parts.join("\n");
    const at = after
      ? pointAtBlockOffset(
          editor,
          line.blockPath,
          line.start + line.text.length,
        )
      : pointAtBlockOffset(editor, line.blockPath, line.start);
    Transforms.insertText(editor, after ? `\n${text}` : `${text}\n`, { at });
    const target = after ? from.li + 1 : from.li;
    const now = getLines(editor);
    selectPos(editor, "normal", {
      li: target,
      off: firstNonBlank(now[target]),
    });
    return;
  }

  const parentPath = Path.parent(line.blockPath);
  const parent = parentPath.length > 0 ? Node.get(editor, parentPath) : null;
  const intoList = parent !== null && isListItem(parent);
  const unit = intoList ? parentPath : line.blockPath;
  const at = after ? Path.next(unit) : unit;
  const nodes: Descendant[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push(...adaptNodes(register.fragment, intoList));
  }
  Transforms.insertNodes(editor, nodes, { at });
  const now = getLines(editor);
  const point = Editor.start(editor, at);
  const pos = posOfPoint(editor, now, point);
  selectPos(editor, "normal", {
    li: pos.li,
    off: firstNonBlank(now[pos.li]),
  });
}

export function pasteCharwise(
  editor: Editor,
  register: Register,
  after: boolean,
  count: number,
): void {
  const lines = getLines(editor);
  const from = cursorPos(editor, lines);
  const line = lines[from.li];
  const at =
    after && line.text.length > 0
      ? { li: from.li, off: nextBoundary(line.text, from.off) }
      : from;
  Transforms.select(editor, pointOfPos(editor, lines, at));
  const n = Math.min(count, MAX_PASTE_COUNT);
  for (let i = 0; i < n; i++) {
    Transforms.insertFragment(editor, structuredClone(register.fragment));
  }
  // Vim leaves the caret on the last pasted character.
  const head = editor.selection?.focus;
  if (head) {
    const before = Editor.before(editor, head, { unit: "character" });
    const now = getLines(editor);
    const pos = posOfPoint(editor, now, before ?? head);
    selectPos(editor, "normal", pos);
  }
}
