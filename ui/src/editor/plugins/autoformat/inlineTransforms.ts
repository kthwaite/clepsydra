import {
  Editor,
  Node,
  Path,
  type Point,
  Element as SlateElement,
  Text,
  Transforms,
} from "slate";
import { HistoryEditor } from "slate-history";
import { matchTrailingInlineProperty } from "#/editor/properties";
import { makeFootnoteDef } from "#/editor/schema/elements/footnoteDef";
import { makeFootnoteRef } from "#/editor/schema/elements/footnoteRef";
import { makeWikilink } from "#/editor/schema/elements/wikilink";
import type { CustomElement } from "#/editor/types";

type MarkType = "bold" | "italic" | "strikethrough" | "code";

// An opener delimiter is valid at text start or after whitespace, punctuation,
// or a symbol (CommonMark left-flanking). Letters and digits reject, so
// mid-word delimiters (snake_case, file`names`) never trigger.
const OPENER_BOUNDARY = /[\s\p{P}\p{S}]/u;

function isOpenerBoundary(charBefore: string): boolean {
  return OPENER_BOUNDARY.test(charBefore);
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

/**
 * Attempts an inline transform triggered by the typed character.
 * Returns true if a transform was applied, false otherwise.
 *
 * @param closerConsumed - When true, the closing character is already in the
 *   text (e.g. after overtype moved past it). The search adjusts accordingly.
 */
export function tryInlineTransform(
  editor: Editor,
  typed: string,
  closerConsumed = false,
): boolean {
  if (isInCodeContext(editor)) return false;

  // Link transforms: ] continues [text, ) closes [text](url)
  // A completed [key:: value] pair claims the ] before the link scaffold does.
  if (typed === "]") {
    if (tryInlinePropertyTransform(editor, closerConsumed)) return true;
    return tryBracketTransform(editor, closerConsumed);
  }
  if (typed === ")") return tryLinkTransform(editor, closerConsumed);

  // Mark transforms: *, _, ~, `
  if (typed === "*" || typed === "_")
    return tryMarkTransform(editor, typed, closerConsumed);
  if (typed === "~") return tryMarkTransform(editor, typed, closerConsumed);
  if (typed === "`") return tryMarkTransform(editor, typed, closerConsumed);

  return false;
}

function isInCodeBlock(editor: Editor): boolean {
  const { selection } = editor;
  if (!selection) return false;

  const [match] = Editor.nodes(editor, {
    at: selection,
    match: (n) =>
      SlateElement.isElement(n) &&
      !Editor.isEditor(n) &&
      (n as any).type === "code-block",
  });
  return !!match;
}
function isInCodeContext(editor: Editor): boolean {
  if (isInCodeBlock(editor)) return true;
  return Editor.marks(editor)?.code === true;
}

function getTextBefore(
  editor: Editor,
): { text: string; path: number[] } | null {
  const { selection } = editor;
  if (!selection) return null;

  const { anchor } = selection;
  const [node] = Editor.node(editor, anchor.path);
  if (!("text" in (node as any))) return null;

  const text = (node as any).text as string;
  const textBefore = text.slice(0, anchor.offset);
  return { text: textBefore, path: anchor.path as unknown as number[] };
}

export function selectTextAfterInline(editor: Editor, inlinePath: Path): void {
  const textPath = Path.next(inlinePath);
  const nextNode = Editor.hasPath(editor, textPath)
    ? Editor.node(editor, textPath)[0]
    : undefined;

  if (!nextNode || !Text.isText(nextNode)) {
    Transforms.insertNodes(editor, { text: "" }, { at: textPath });
  }
  Transforms.select(editor, { path: textPath, offset: 0 });
}

function hasInvalidBracketSyntax(
  text: string,
  openBracketIdx: number,
  contentEnd: number,
): boolean {
  const label = text.slice(openBracketIdx + 1, contentEnd);
  if (label.includes("[") || label.includes("]")) return true;

  let unmatchedOpeners = 0;
  for (let i = 0; i < openBracketIdx; i++) {
    if (text[i] === "[") unmatchedOpeners++;
    if (text[i] === "]" && unmatchedOpeners > 0) unmatchedOpeners--;
  }
  return unmatchedOpeners > 0;
}

function tryMarkTransform(
  editor: Editor,
  typed: string,
  closerConsumed = false,
): boolean {
  const info = getTextBefore(editor);
  if (!info) return false;

  const { text: textBefore, path } = info;
  const offset = textBefore.length;

  // Determine closer width.
  // When closerConsumed is true the full closer is already in textBefore
  // (e.g. after overtype), so we must not bump to double-width just because
  // the last char matches — the closer is already complete at width 1.
  let closerWidth = 1;
  if (
    !closerConsumed &&
    (typed === "*" || typed === "_") &&
    offset > 0 &&
    textBefore[offset - 1] === typed
  ) {
    closerWidth = 2;
  }

  // For tilde and backtick, always single width
  if (typed === "~" || typed === "`") {
    closerWidth = 1;
  }

  // Search backward for the opener.
  // closerAlreadyInText: how many closer chars are already in textBefore.
  // Normal path (closerConsumed=false): closerWidth - 1 (the typed char hasn't been inserted yet).
  // Overtype path (closerConsumed=true): the full closer is in textBefore.
  const closerAlreadyInText = closerConsumed ? closerWidth : closerWidth - 1;
  const searchEnd = offset - closerAlreadyInText;

  // Find opener in textBefore
  let openerStart = -1;
  for (let i = searchEnd - 1; i >= 0; i--) {
    // Check if opener matches at position i
    if (i + closerWidth > searchEnd) continue;

    let matches = true;
    for (let j = 0; j < closerWidth; j++) {
      if (textBefore[i + j] !== typed) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;

    // Opener validity: at text start or preceded by a boundary char
    if (i > 0 && !isOpenerBoundary(textBefore[i - 1])) continue;

    // Make sure it's exactly the right width (not more chars of same type before)
    if (i > 0 && textBefore[i - 1] === typed) continue;

    // Make sure it's exactly the right width (not more chars of same type after opener)
    if (i + closerWidth < searchEnd && textBefore[i + closerWidth] === typed)
      continue;

    openerStart = i;
    break;
  }

  if (openerStart === -1) return false;

  const contentStart = openerStart + closerWidth;
  const contentEnd = searchEnd;
  const content = textBefore.slice(contentStart, contentEnd);

  // Empty content check
  if (content.length === 0) return false;

  // Determine mark
  let mark: MarkType;
  if (typed === "`") {
    mark = "code";
  } else if (typed === "~") {
    mark = "strikethrough";
  } else if (closerWidth === 2) {
    mark = "bold";
  } else {
    mark = "italic";
  }

  // Perform the transform
  // Range from opener start to cursor (which is at offset; the closer char hasn't been inserted)
  const rangeStart: Point = { path: path as any, offset: openerStart };
  const rangeEnd: Point = { path: path as any, offset };

  HistoryEditor.withNewBatch(editor as any, () => {
    Editor.withoutNormalizing(editor, () => {
      // Delete the markdown syntax
      Transforms.select(editor, { anchor: rangeStart, focus: rangeEnd });
      Transforms.delete(editor);

      // Insert content with mark
      Transforms.insertNodes(editor, { text: content, [mark]: true } as any);
    });
  });

  return true;
}

function tryWikilinkTransform(
  editor: Editor,
  textBefore: string,
  path: number[],
  closerConsumed: boolean,
): boolean {
  const closeStart = textBefore.length - (closerConsumed ? 2 : 1);
  const expectedCloser = closerConsumed ? "]]" : "]";
  if (!textBefore.endsWith(expectedCloser)) return false;

  const openerStart = textBefore.lastIndexOf("[[", closeStart - 1);
  if (openerStart === -1) return false;

  const inner = textBefore.slice(openerStart + 2, closeStart);
  if (inner.includes("[") || inner.includes("]")) return false;

  const dividerIndex = inner.indexOf("|");
  const target = dividerIndex === -1 ? inner : inner.slice(0, dividerIndex);
  const alias = dividerIndex === -1 ? undefined : inner.slice(dividerIndex + 1);
  if (target.trim().length === 0 || alias?.trim().length === 0) return false;

  const rangeStart: Point = { path, offset: openerStart };
  const rangeEnd: Point = { path, offset: textBefore.length };
  HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
    Editor.withoutNormalizing(editor, () => {
      Transforms.select(editor, { anchor: rangeStart, focus: rangeEnd });
      Transforms.delete(editor);
      Transforms.insertNodes(editor, makeWikilink({ target, alias }));
      const wikilinkPath = editor.selection?.anchor.path.slice(0, -1);
      if (wikilinkPath) selectTextAfterInline(editor, wikilinkPath);
    });
  });
  return true;
}

type PropertyBearingElement = CustomElement & {
  properties?: Record<string, string>;
};

/**
 * The block a typed property belongs to. The loader records a list item's
 * metadata on the item rather than on its paragraph (`mdast-to-slate` converts
 * item children with extraction disabled), so a property typed inside a task
 * item has to land there too — otherwise the item's chips and the save/reload
 * round-trip would disagree about where the property lives.
 */
function propertyOwnerEntry(
  editor: Editor,
): [PropertyBearingElement, Path] | null {
  const { selection } = editor;
  if (!selection) return null;

  const blockEntry = Editor.above(editor, {
    at: selection.anchor,
    match: (node) =>
      SlateElement.isElement(node) &&
      !Editor.isEditor(node) &&
      Editor.isBlock(editor, node),
  });
  if (!blockEntry) return null;

  const [block, blockPath] = blockEntry as [PropertyBearingElement, Path];
  if (block.type === "paragraph" && blockPath.length > 1) {
    const parentPath = Path.parent(blockPath);
    const parent = Node.get(editor, parentPath);
    if (
      SlateElement.isElement(parent) &&
      (parent as CustomElement).type === "list-item"
    ) {
      return [parent as PropertyBearingElement, parentPath];
    }
  }
  return [block, blockPath];
}

/**
 * `[key:: value]` typed in the editor becomes a block property instead of
 * literal text, mirroring how the same syntax is read out of a saved file.
 * Runs ahead of the link scaffold, which would otherwise turn the pair into
 * `[key:: value]()`.
 */
function tryInlinePropertyTransform(
  editor: Editor,
  closerConsumed: boolean,
): boolean {
  const info = getTextBefore(editor);
  if (!info) return false;

  const { text: textBefore, path } = info;
  if (closerConsumed && !textBefore.endsWith("]")) return false;
  // Unless overtype already consumed it, the typed ] is not in the text yet.
  const candidate = closerConsumed ? textBefore : `${textBefore}]`;
  const match = matchTrailingInlineProperty(candidate);
  if (!match) return false;

  const owner = propertyOwnerEntry(editor);
  if (!owner) return false;
  const [block, blockPath] = owner;

  // Swallow the whitespace separating the pair from the text it annotates;
  // serialization re-inserts it, so keeping it would grow the line on each
  // save/reload cycle.
  let deleteStart = match.index;
  while (
    deleteStart > 0 &&
    (textBefore[deleteStart - 1] === " " ||
      textBefore[deleteStart - 1] === "\t")
  ) {
    deleteStart--;
  }

  const properties = { ...block.properties, [match.key]: match.value };

  HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
    Editor.withoutNormalizing(editor, () => {
      Transforms.select(editor, {
        anchor: { path, offset: deleteStart },
        focus: { path, offset: textBefore.length },
      });
      Transforms.delete(editor);
      Transforms.setNodes<PropertyBearingElement>(
        editor,
        { properties },
        { at: blockPath },
      );
    });
  });

  return true;
}

function tryBracketTransform(editor: Editor, closerConsumed = false): boolean {
  const info = getTextBefore(editor);
  if (!info) return false;

  const { text: textBefore, path } = info;
  if (tryWikilinkTransform(editor, textBefore, path, closerConsumed)) {
    return true;
  }

  if (closerConsumed && !textBefore.endsWith("]")) return false;
  const contentEnd = textBefore.length - (closerConsumed ? 1 : 0);
  const openBracketIdx = textBefore.lastIndexOf("[", contentEnd - 1);
  if (openBracketIdx === -1) return false;
  // An odd backslash run before `[` starts backslash-bracket math syntax.
  // An even run escapes the final backslash, so the bracket remains eligible
  // for ordinary link-label autoformat.
  if (isEscaped(textBefore, openBracketIdx)) return false;
  if (openBracketIdx > 0 && !isOpenerBoundary(textBefore[openBracketIdx - 1]))
    return false;
  if (hasInvalidBracketSyntax(textBefore, openBracketIdx, contentEnd))
    return false;

  const label = textBefore.slice(openBracketIdx + 1, contentEnd);
  if (label.length === 0) return false;

  if (label.startsWith("^")) {
    const identifier = label.slice(1);
    if (identifier.trim().length === 0) return false;

    const hasDefinition = editor.children.some((node) => {
      if (!SlateElement.isElement(node)) return false;
      const element = node as CustomElement;
      return (
        element.type === "footnote-def" && element.identifier === identifier
      );
    });

    const rangeStart: Point = {
      path,
      offset: openBracketIdx,
    };
    const rangeEnd: Point = {
      path,
      offset: textBefore.length,
    };

    HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
      Editor.withoutNormalizing(editor, () => {
        Transforms.select(editor, { anchor: rangeStart, focus: rangeEnd });
        Transforms.delete(editor);
        Transforms.insertNodes(editor, makeFootnoteRef({ identifier }));
        const referencePath = editor.selection?.anchor.path.slice(0, -1);

        if (!hasDefinition) {
          Transforms.insertNodes(editor, makeFootnoteDef({ identifier }), {
            at: [editor.children.length],
          });
        }
        if (referencePath) selectTextAfterInline(editor, referencePath);
      });
    });
    return true;
  }

  HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
    Transforms.insertText(editor, closerConsumed ? "()" : "]()");
    Transforms.move(editor, {
      distance: 1,
      unit: "character",
      reverse: true,
    });
  });
  return true;
}

function tryLinkTransform(editor: Editor, closerConsumed = false): boolean {
  const info = getTextBefore(editor);
  if (!info) return false;

  const { text: textBefore, path } = info;
  if (closerConsumed && !textBefore.endsWith(")")) return false;
  const contentEnd = textBefore.length - (closerConsumed ? 1 : 0);

  // Find ]( pattern
  const bracketParenIdx = textBefore.lastIndexOf("](", contentEnd);
  if (bracketParenIdx === -1) return false;

  // Find [ before ](
  const openBracketIdx = textBefore.lastIndexOf("[", bracketParenIdx - 1);
  if (openBracketIdx === -1) return false;

  // Opener validity: at text start or preceded by a boundary char
  if (openBracketIdx > 0 && !isOpenerBoundary(textBefore[openBracketIdx - 1]))
    return false;
  if (hasInvalidBracketSyntax(textBefore, openBracketIdx, bracketParenIdx))
    return false;

  const linkText = textBefore.slice(openBracketIdx + 1, bracketParenIdx);
  const url = textBefore.slice(bracketParenIdx + 2, contentEnd);

  if (linkText.length === 0 || linkText.startsWith("^") || url.length === 0) {
    return false;
  }

  const rangeStart: Point = { path, offset: openBracketIdx };
  const rangeEnd: Point = { path, offset: textBefore.length };

  HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
    Editor.withoutNormalizing(editor, () => {
      // Delete the markdown link syntax
      Transforms.select(editor, { anchor: rangeStart, focus: rangeEnd });
      Transforms.delete(editor);

      // Insert link element. withSchema marks link elements as inline.
      const linkNode: CustomElement = {
        type: "link",
        url,
        children: [{ text: linkText }],
      };
      Transforms.insertNodes(editor, linkNode);
      const insertedLinkPath = editor.selection?.anchor.path.slice(0, -1);
      if (insertedLinkPath) selectTextAfterInline(editor, insertedLinkPath);
    });
  });

  return true;
}
