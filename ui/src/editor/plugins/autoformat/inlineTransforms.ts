import { Editor, Element as SlateElement, Transforms, type Point } from "slate";
import { HistoryEditor } from "slate-history";

type MarkType = "bold" | "italic" | "strikethrough" | "code";

/**
 * Attempts an inline transform triggered by the typed character.
 * Returns true if a transform was applied, false otherwise.
 */
export function tryInlineTransform(editor: Editor, typed: string): boolean {
  // Context guard: no transforms inside code-block
  if (isInCodeBlock(editor)) return false;

  // Link transform: ) closes [text](url)
  if (typed === ")") return tryLinkTransform(editor);

  // Mark transforms: *, _, ~, `
  if (typed === "*" || typed === "_") return tryMarkTransform(editor, typed);
  if (typed === "~") return tryMarkTransform(editor, typed);
  if (typed === "`") return tryMarkTransform(editor, typed);

  return false;
}

function isInCodeBlock(editor: Editor): boolean {
  const { selection } = editor;
  if (!selection) return false;

  const [match] = Editor.nodes(editor, {
    at: selection,
    match: (n) => SlateElement.isElement(n) && !Editor.isEditor(n) && (n as any).type === "code-block",
  });
  return !!match;
}

function getTextBefore(editor: Editor): { text: string; path: number[] } | null {
  const { selection } = editor;
  if (!selection) return null;

  const { anchor } = selection;
  const [node] = Editor.node(editor, anchor.path);
  if (!("text" in (node as any))) return null;

  const text = (node as any).text as string;
  const textBefore = text.slice(0, anchor.offset);
  return { text: textBefore, path: anchor.path as unknown as number[] };
}

function tryMarkTransform(editor: Editor, typed: string): boolean {
  const info = getTextBefore(editor);
  if (!info) return false;

  const { text: textBefore, path } = info;
  const offset = textBefore.length;

  // Determine closer width
  let closerWidth = 1;
  if ((typed === "*" || typed === "_") && offset > 0 && textBefore[offset - 1] === typed) {
    closerWidth = 2;
  }

  // For tilde and backtick, always single width
  if (typed === "~" || typed === "`") {
    closerWidth = 1;
  }

  // Search backward for the opener
  // The closer hasn't been typed yet, so textBefore is everything before cursor.
  // For double-width closer: the last char of textBefore is the first closer char,
  // so content is between opener end and (offset - (closerWidth - 1))
  const closerAlreadyInText = closerWidth - 1; // chars of the closer already in textBefore
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
    if (i + closerWidth < searchEnd && textBefore[i + closerWidth] === typed) continue;

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

function tryLinkTransform(editor: Editor): boolean {
  const info = getTextBefore(editor);
  if (!info) return false;

  const { text: textBefore, path } = info;

  // Find ]( pattern
  const bracketParenIdx = textBefore.lastIndexOf("](");
  if (bracketParenIdx === -1) return false;

  // Find [ before ](
  const openBracketIdx = textBefore.lastIndexOf("[", bracketParenIdx - 1);
  if (openBracketIdx === -1) return false;

  // Opener validity: at text start or preceded by whitespace
  if (openBracketIdx > 0 && !/\s/.test(textBefore[openBracketIdx - 1])) return false;

  const linkText = textBefore.slice(openBracketIdx + 1, bracketParenIdx);
  const url = textBefore.slice(bracketParenIdx + 2);

  if (linkText.length === 0 || url.length === 0) return false;

  const rangeStart: Point = { path: path as any, offset: openBracketIdx };
  const rangeEnd: Point = { path: path as any, offset: textBefore.length };

  // Ensure the editor recognises link elements as inline so that
  // Transforms.insertNodes places them inside the paragraph.
  const origIsInline = editor.isInline;
  editor.isInline = (element: any) =>
    element.type === "link" ? true : origIsInline(element);

  HistoryEditor.withNewBatch(editor as any, () => {
    Editor.withoutNormalizing(editor, () => {
      // Delete the markdown link syntax
      Transforms.select(editor, { anchor: rangeStart, focus: rangeEnd });
      Transforms.delete(editor);

      // Insert link element
      const linkNode = {
        type: "link",
        url,
        children: [{ text: linkText }],
      };
      Transforms.insertNodes(editor, linkNode as any);
    });
  });

  editor.isInline = origIsInline;

  return true;
}
