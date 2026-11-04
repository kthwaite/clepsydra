/**
 * Undo after a typed transform, then keep typing. Every transform is driven key
 * by key through the production plugin chain, at a caret with text on both sides,
 * in a paragraph and in a list item. The undo must give back the text as it stood
 * before the last key, with a collapsed caret, so the next key adds to that text
 * rather than replacing it.
 */
import {
  createEditor,
  type Descendant,
  Editor,
  Node,
  Range,
  Transforms,
} from "slate";
import { HistoryEditor, withHistory } from "slate-history";
import { withReact } from "slate-react";
import { describe, expect, it } from "vitest";
import { withBlockVoidDeletion } from "#/editor/plugins/withBlockVoidDeletion";
import { withInlinePunctuationBoundary } from "#/editor/plugins/withInlinePunctuationBoundary";
import { withMarkdownPaste } from "#/editor/plugins/withMarkdownPaste";
import { withMathClipboard } from "#/editor/plugins/withMathClipboard";
import { withOutliner } from "#/editor/plugins/withOutliner";
import { withTables } from "#/editor/plugins/withTables";
import { withSchema } from "#/editor/schema/withSchema";
import { withAutoformat } from "../withAutoformat";

function makeEditor(children: Descendant[]): Editor {
  const editor = withMathClipboard(
    withMarkdownPaste(
      withReact(
        withInlinePunctuationBoundary(
          withHistory(
            withAutoformat(
              withOutliner(
                withBlockVoidDeletion(withTables(withSchema(createEditor()))),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  editor.children = children;
  return editor;
}

const flush = () => Promise.resolve();

async function typeKeys(editor: Editor, keys: string) {
  for (const key of keys) {
    Editor.insertText(editor, key);
    await flush();
  }
}

const paragraph = (text: string): Descendant => ({
  type: "paragraph",
  children: [{ text }],
});
const listOf = (text: string) =>
  ({
    type: "bulleted-list",
    children: [{ type: "list-item", children: [paragraph(text)] }],
  }) as unknown as Descendant;

const HEAD = "see ";
const TAIL = " tail";

const CONTEXTS: Array<[string, (text: string) => Descendant]> = [
  ["a paragraph", paragraph],
  ["a list item", listOf],
];

/** Keys, then the text before the caret once the transform is undone. */
const TRANSFORMS: Array<[string, string, string]> = [
  ["bold", "**x**", "**x*"],
  ["italic with asterisks", "*x*", "*x*"],
  ["italic with underscores", "_x_", "_x_"],
  ["strikethrough", "~x~", "~x"],
  ["inline code", "`x`", "`x"],
  ["wikilink", "[[x]]", "[[x]"],
  ["aliased wikilink", "[[x|y]]", "[[x|y]"],
  ["dollar math", "$x$", "$x"],
  ["paren math", "\\(x\\)", "\\(x\\"],
  ["footnote reference", "[^x]", "[^x"],
  ["inline property", "[k:: v]", "[k:: v"],
  // `]` scaffolds `]()`, so these keys fill the scaffold and overtype its `)`.
  ["link", "[y]u)", "[y](u)"],
  ["bare prefixed link", "wiki:Frida ", "wiki:Frida"],
  ["quoted prefixed link", 'wiki:"Frida Kahlo"', 'wiki:"Frida Kahlo'],
];

describe.each(CONTEXTS)("undoing a typed transform in %s", (_name, wrap) => {
  it.each(TRANSFORMS)(
    "%s: the next key adds to the restored text",
    async (_label, keys, literal) => {
      const editor = makeEditor([wrap(HEAD + TAIL)]);
      const start = Editor.start(editor, []);
      Transforms.select(editor, { path: start.path, offset: HEAD.length });
      await typeKeys(editor, keys);
      expect(Node.string(editor)).not.toContain(literal);

      HistoryEditor.undo(editor as HistoryEditor);
      await flush();

      expect(Node.string(editor)).toBe(`${HEAD}${literal}${TAIL}`);
      expect(editor.selection && Range.isCollapsed(editor.selection)).toBe(
        true,
      );

      await typeKeys(editor, "Z");
      expect(Node.string(editor)).toBe(`${HEAD}${literal}Z${TAIL}`);
    },
  );

  it.each(TRANSFORMS)(
    "%s: redo after undo gives the transform back",
    async (_label, keys) => {
      const editor = makeEditor([wrap(HEAD + TAIL)]);
      const start = Editor.start(editor, []);
      Transforms.select(editor, { path: start.path, offset: HEAD.length });
      await typeKeys(editor, keys);
      const done = JSON.stringify(editor.children);

      HistoryEditor.undo(editor as HistoryEditor);
      await flush();
      HistoryEditor.redo(editor as HistoryEditor);
      await flush();

      expect(JSON.stringify(editor.children)).toBe(done);
    },
  );

  it.each(TRANSFORMS)(
    "%s: undoing everything returns to the start",
    async (_label, keys) => {
      const before = [wrap(HEAD + TAIL)];
      const editor = makeEditor(JSON.parse(JSON.stringify(before)));
      const start = Editor.start(editor, []);
      Transforms.select(editor, { path: start.path, offset: HEAD.length });
      await typeKeys(editor, keys);

      while (editor.history.undos.length > 0) {
        HistoryEditor.undo(editor as HistoryEditor);
        await flush();
      }

      expect(editor.children).toEqual(before);
    },
  );
});

describe("a prefixed link finished with Enter", () => {
  it("undoes to the source text with a collapsed caret", async () => {
    const editor = makeEditor([paragraph(HEAD)]);
    Transforms.select(editor, Editor.end(editor, []));
    await typeKeys(editor, "wiki:Frida");
    Editor.insertBreak(editor);
    await flush();

    HistoryEditor.undo(editor as HistoryEditor);
    await flush();

    expect(Node.string(editor)).toBe(`${HEAD}wiki:Frida`);
    expect(editor.selection && Range.isCollapsed(editor.selection)).toBe(true);

    await typeKeys(editor, "Z");
    expect(Node.string(editor)).toBe(`${HEAD}wiki:FridaZ`);
  });
});

describe("a transform's caret, without any undo", () => {
  it.each([
    ["bold", "**x**"],
    ["wikilink", "[[x]]"],
    ["dollar math", "$x$"],
    ["inline property", "[k:: v]"],
    ["bare prefixed link", "wiki:Frida "],
  ])("%s: the next key lands after the transform", async (_label, keys) => {
    const editor = makeEditor([paragraph(HEAD + TAIL)]);
    const start = Editor.start(editor, []);
    Transforms.select(editor, { path: start.path, offset: HEAD.length });
    await typeKeys(editor, keys);
    await typeKeys(editor, "Z");
    const text = Node.string(editor);
    expect(text.indexOf("Z")).toBeGreaterThanOrEqual(0);
    expect(text.endsWith(`Z${TAIL}`)).toBe(true);
  });
});

describe("a property pair typed across a wikilink", () => {
  it("undoes to a collapsed caret", async () => {
    const editor = makeEditor([paragraph(HEAD)]);
    Transforms.select(editor, Editor.end(editor, []));
    await typeKeys(editor, "[k:: [[x]]]");
    expect(Node.string(editor)).toBe("see");

    HistoryEditor.undo(editor as HistoryEditor);
    await flush();

    expect(editor.selection && Range.isCollapsed(editor.selection)).toBe(true);
  });
});
