import {
  Editor,
  type Point,
  Path,
  Element as SlateElement,
  Transforms,
} from "slate";
import { HistoryEditor } from "slate-history";
import { makeFootnoteDef } from "#/editor/schema/elements/footnoteDef";
import { makeFootnoteRef } from "#/editor/schema/elements/footnoteRef";
import type { CustomElement } from "#/editor/types";

type MarkType = "bold" | "italic" | "strikethrough" | "code";

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
  if (typed === "]") return tryBracketTransform(editor);
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

    // Opener validity: at text start or preceded by whitespace
    if (i > 0 && !/\s/.test(textBefore[i - 1])) continue;

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

function tryBracketTransform(editor: Editor): boolean {
  const info = getTextBefore(editor);
  if (!info) return false;

  const { text: textBefore, path } = info;
  const openBracketIdx = textBefore.lastIndexOf("[");
  if (openBracketIdx === -1) return false;
  if (openBracketIdx > 0 && !/\s/.test(textBefore[openBracketIdx - 1]))
    return false;

  const label = textBefore.slice(openBracketIdx + 1);
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
        const afterPath = referencePath
          ? Path.next(referencePath)
          : undefined;
        if (afterPath && !Editor.hasPath(editor, afterPath)) {
          Transforms.insertNodes(editor, { text: "" }, { at: afterPath });
        }
        const afterReference: Point | undefined = afterPath
          ? { path: afterPath, offset: 0 }
          : undefined;

        if (!hasDefinition) {
          Transforms.insertNodes(editor, makeFootnoteDef({ identifier }), {
            at: [editor.children.length],
          });
        }
        if (afterReference) Transforms.select(editor, afterReference);
      });
    });
    return true;
  }

  HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
    Transforms.insertText(editor, "]()");
    Transforms.move(editor, {
      distance: 1,
      unit: "character",
      reverse: true,
    });
  });
  return true;
}

function tryLinkTransform(
  editor: Editor,
  closerConsumed = false,
): boolean {
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

  // Opener validity: at text start or preceded by whitespace
  if (openBracketIdx > 0 && !/\s/.test(textBefore[openBracketIdx - 1]))
    return false;

  const linkText = textBefore.slice(openBracketIdx + 1, bracketParenIdx);
  const url = textBefore.slice(bracketParenIdx + 2, contentEnd);

  if (
    linkText.length === 0 ||
    linkText.startsWith("^") ||
    url.length === 0
  ) {
    return false;
  }

  const rangeStart: Point = { path: path as any, offset: openBracketIdx };
  const rangeEnd: Point = { path: path as any, offset: textBefore.length };

  HistoryEditor.withNewBatch(editor as any, () => {
    Editor.withoutNormalizing(editor, () => {
      // Delete the markdown link syntax
      Transforms.select(editor, { anchor: rangeStart, focus: rangeEnd });
      Transforms.delete(editor);

      // Insert link element. withSchema marks link elements as inline.
      const linkNode = {
        type: "link",
        url,
        children: [{ text: linkText }],
      };
      Transforms.insertNodes(editor, linkNode as any);
    });
  });

  return true;
}
