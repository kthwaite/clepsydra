import {
  Editor,
  Path,
  type Point,
  Range,
  Element as SlateElement,
  Text,
  Transforms,
} from "slate";
import { HistoryEditor } from "slate-history";
import { makeInlineMath, makeMathBlock } from "#/editor/schema/elements/math";
import { formatMathSource, type MathDelimiter } from "#/lib/markdown/folioMath";
import { selectTextAfterInline } from "./inlineTransforms";

type MathMatch = {
  delimiter: MathDelimiter;
  tex: string;
  start: number;
};

/**
 * Convert a complete math delimiter pair ending at the collapsed selection.
 * Matching is intentionally limited to the current text leaf and its immediate
 * block; it never scans or rewrites the document.
 */
export function tryMathTransform(
  editor: Editor,
  typed: string,
  closerConsumed = false,
): boolean {
  if (typed !== "$" && typed !== ")" && typed !== "]") return false;

  const { selection } = editor;
  if (!selection || !Range.isCollapsed(selection)) return false;

  const { anchor } = selection;
  const [leaf] = Editor.node(editor, anchor.path);
  if (!Text.isText(leaf) || leaf.code === true) return false;
  if (Editor.marks(editor)?.code === true) return false;

  const blockEntry = Editor.above(editor, {
    at: anchor,
    match: (node) =>
      SlateElement.isElement(node) &&
      !Editor.isEditor(node) &&
      Editor.isBlock(editor, node),
    mode: "lowest",
  });
  if (!blockEntry) return false;

  const [block, blockPath] = blockEntry;
  if (!SlateElement.isElement(block)) return false;
  if (block.type === "code-block") return false;

  const textBefore = leaf.text.slice(0, anchor.offset);
  const sourceBefore = closerConsumed ? textBefore : textBefore + typed;

  const display = matchDisplay(
    typed,
    sourceBefore,
    leaf,
    block,
    anchor,
    closerConsumed,
  );
  if (display) {
    replaceDisplay(editor, blockPath, display);
    return true;
  }

  const inline = matchInline(typed, sourceBefore);
  if (!inline) return false;

  replaceInline(editor, anchor.path, anchor.offset, inline);
  return true;
}

/**
 * Insert a literal newline while authoring a standalone display expression.
 * Display math is stored in one paragraph text leaf until its closer converts
 * the paragraph, so Slate's default block split would strand the opener.
 */
export function tryDisplayMathNewline(editor: Editor): boolean {
  const context = currentMathCandidateContext(editor);
  if (!context) return false;

  const { block, leaf, textBefore } = context;
  if (
    block.type !== "paragraph" ||
    block.children.length !== 1 ||
    block.children[0] !== leaf ||
    !hasUnmatchedDisplayOpener(textBefore)
  ) {
    return false;
  }

  Transforms.insertText(editor, "\n");
  return true;
}

/**
 * Whether the collapsed selection is inside an unmatched, supported math
 * opener in the current leaf. Autoformat callers use this to keep TeX body
 * punctuation literal until the matching math closer is typed.
 */
export function isInMathCandidate(editor: Editor): boolean {
  const context = currentMathCandidateContext(editor);
  if (!context) return false;

  const { block, leaf, textBefore } = context;
  if (
    block.type === "paragraph" &&
    block.children.length === 1 &&
    block.children[0] === leaf &&
    hasUnmatchedDisplayOpener(textBefore)
  ) {
    return true;
  }

  return (
    hasUnclosedBackslashParen(textBefore) ||
    hasUnclosedInlineDollar(textBefore)
  );
}

function currentMathCandidateContext(
  editor: Editor,
): { block: SlateElement; leaf: Text; textBefore: string } | null {
  const { selection } = editor;
  if (!selection || !Range.isCollapsed(selection)) return null;

  const { anchor } = selection;
  const [leaf] = Editor.node(editor, anchor.path);
  if (!Text.isText(leaf) || leaf.code === true) return null;
  if (Editor.marks(editor)?.code === true) return null;

  const blockEntry = Editor.above(editor, {
    at: anchor,
    match: (node) =>
      SlateElement.isElement(node) &&
      !Editor.isEditor(node) &&
      Editor.isBlock(editor, node),
    mode: "lowest",
  });
  if (!blockEntry) return null;

  const [block] = blockEntry;
  if (!SlateElement.isElement(block) || block.type === "code-block") return null;

  return {
    block,
    leaf,
    textBefore: leaf.text.slice(0, anchor.offset),
  };
}


function hasUnmatchedDisplayOpener(textBefore: string): boolean {
  return (
    (textBefore.startsWith("$$") &&
      !textBefore.startsWith("$$$") &&
      !hasDisplayDollarCloser(textBefore)) ||
    (textBefore.startsWith("\\[") &&
      !hasUnescapedSequence(textBefore, "\\]", 2))
  );
}

function hasDisplayDollarCloser(text: string): boolean {
  for (let index = 2; index < text.length - 1; index++) {
    if (
      text[index] === "$" &&
      text[index + 1] === "$" &&
      text[index - 1] !== "$" &&
      text[index + 2] !== "$" &&
      !isEscaped(text, index)
    ) {
      return true;
    }
  }
  return false;
}

function hasUnescapedSequence(
  text: string,
  sequence: string,
  from: number,
): boolean {
  let index = text.indexOf(sequence, from);
  while (index >= 0) {
    if (!isEscaped(text, index)) return true;
    index = text.indexOf(sequence, index + 1);
  }
  return false;
}

function hasUnclosedBackslashParen(text: string): boolean {
  let open = false;
  for (let index = 0; index < text.length - 1; index++) {
    if (text[index] !== "\\" || isEscaped(text, index)) continue;
    if (text[index + 1] === "(") {
      open = true;
      index++;
    } else if (text[index + 1] === ")" && open) {
      open = false;
      index++;
    }
  }
  return open;
}

function hasUnclosedInlineDollar(text: string): boolean {
  let open = false;
  for (let index = 0; index < text.length; ) {
    if (text[index] !== "$") {
      index++;
      continue;
    }

    let end = index + 1;
    while (text[end] === "$") end++;
    if (end - index === 1 && !isEscaped(text, index)) open = !open;
    index = end;
  }
  return open;
}

function matchInline(typed: string, sourceBefore: string): MathMatch | null {
  if (typed === "$") {
    const close = sourceBefore.length - 1;
    if (close <= 0 || isEscaped(sourceBefore, close)) return null;

    const start = findUnescaped(sourceBefore, "$", close - 1);
    if (start < 0 || start === close - 1) return null;
    if (sourceBefore[start - 1] === "$" || sourceBefore[start + 1] === "$") {
      return null;
    }
    if (sourceBefore[close - 1] === "$" || sourceBefore.includes("\n", start)) {
      return null;
    }

    const tex = sourceBefore.slice(start + 1, close);
    return exactMatch(sourceBefore, start, tex, "$");
  }

  if (typed !== ")" || !sourceBefore.endsWith("\\)")) return null;

  const closeStart = sourceBefore.length - 2;
  if (isEscaped(sourceBefore, closeStart)) return null;
  const start = findUnescaped(sourceBefore, "\\(", closeStart - 1);
  if (start < 0) return null;

  const tex = sourceBefore.slice(start + 2, closeStart);
  if (tex.length === 0 || tex.includes("\n")) return null;
  return exactMatch(sourceBefore, start, tex, "\\(");
}

function matchDisplay(
  typed: string,
  sourceBefore: string,
  leaf: Text,
  block: SlateElement,
  anchor: Point,
  closerConsumed: boolean,
): MathMatch | null {
  if (
    block.type !== "paragraph" ||
    block.children.length !== 1 ||
    block.children[0] !== leaf ||
    anchor.offset !== leaf.text.length ||
    leaf.text !==
      (closerConsumed ? sourceBefore : sourceBefore.slice(0, -typed.length))
  ) {
    return null;
  }

  if (
    typed === "$" &&
    sourceBefore.startsWith("$$") &&
    !sourceBefore.startsWith("$$$") &&
    sourceBefore.endsWith("$$")
  ) {
    const tex = sourceBefore.slice(2, -2);
    if (tex.length === 0) return null;
    return exactMatch(sourceBefore, 0, tex, "$$");
  }

  if (
    typed === "]" &&
    sourceBefore.startsWith("\\[") &&
    sourceBefore.endsWith("\\]")
  ) {
    const closeStart = sourceBefore.length - 2;
    if (isEscaped(sourceBefore, closeStart)) return null;
    const tex = sourceBefore.slice(2, closeStart);
    if (tex.length === 0) return null;
    return exactMatch(sourceBefore, 0, tex, "\\[");
  }

  return null;
}

function exactMatch(
  sourceBefore: string,
  start: number,
  tex: string,
  delimiter: MathDelimiter,
): MathMatch | null {
  return sourceBefore.slice(start) === formatMathSource(tex, delimiter)
    ? { delimiter, tex, start }
    : null;
}

function findUnescaped(text: string, needle: string, from: number): number {
  let index = text.lastIndexOf(needle, from);
  while (index >= 0 && isEscaped(text, index)) {
    index = text.lastIndexOf(needle, index - 1);
  }
  return index;
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && text[cursor] === "\\";
    cursor--
  ) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function replaceInline(
  editor: Editor,
  path: Path,
  endOffset: number,
  match: MathMatch,
): void {
  const rangeStart: Point = { path, offset: match.start };
  const rangeEnd: Point = { path, offset: endOffset };

  HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
    Editor.withoutNormalizing(editor, () => {
      Transforms.select(editor, { anchor: rangeStart, focus: rangeEnd });
      Transforms.delete(editor);
      Transforms.insertNodes(
        editor,
        makeInlineMath({
          tex: match.tex,
          delimiter: match.delimiter as "$" | "\\(",
        }),
      );
      const insertedPath = editor.selection?.anchor.path.slice(0, -1);
      if (insertedPath) selectTextAfterInline(editor, insertedPath);
    });
  });
}

function replaceDisplay(editor: Editor, blockPath: Path, match: MathMatch): void {
  HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
    Editor.withoutNormalizing(editor, () => {
      Transforms.removeNodes(editor, { at: blockPath });
      Transforms.insertNodes(
        editor,
        makeMathBlock({
          tex: match.tex,
          delimiter: match.delimiter as "$$" | "\\[",
        }),
        { at: blockPath },
      );
      const followingPath = Path.next(blockPath);
      Transforms.insertNodes(
        editor,
        { type: "paragraph", children: [{ text: "" }] },
        { at: followingPath },
      );
      Transforms.select(editor, { path: followingPath.concat(0), offset: 0 });
    });
  });
}
