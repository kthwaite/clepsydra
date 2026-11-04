/**
 * A Markdown link typed key by key through the production plugin chain. The `]`
 * scaffolds `]()` with the caret inside, so the `(` a typist goes on to press is
 * already there.
 */
import { createEditor, type Descendant, Editor, Transforms } from "slate";
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
const list = (text: string) =>
  ({
    type: "bulleted-list",
    children: [{ type: "list-item", children: [paragraph(text)] }],
  }) as unknown as Descendant;

function linkUrl(editor: Editor): string | undefined {
  const [entry] = Editor.nodes(editor, {
    at: [],
    match: (n) => "url" in n,
  });
  return (entry?.[0] as { url?: string } | undefined)?.url;
}

describe("a Markdown link typed in full", () => {
  it.each<[string, Descendant]>([
    ["a paragraph", paragraph("see ")],
    ["a list item", list("see ")],
  ])("gets the typed URL in %s", async (_name, block) => {
    const editor = makeEditor([block]);
    Transforms.select(editor, Editor.end(editor, []));
    await typeKeys(editor, "[y](https://a.io/b)");
    expect(linkUrl(editor)).toBe("https://a.io/b");
  });

  it("leaves the caret after the link", async () => {
    const editor = makeEditor([paragraph("see ")]);
    Transforms.select(editor, Editor.end(editor, []));
    await typeKeys(editor, "[y](u) after");
    expect(linkUrl(editor)).toBe("u");
    expect(Editor.string(editor, [])).toBe("see y after");
  });

  it("still fills the scaffold when the ( is not typed", async () => {
    const editor = makeEditor([paragraph("see ")]);
    Transforms.select(editor, Editor.end(editor, []));
    await typeKeys(editor, "[y]u)");
    expect(linkUrl(editor)).toBe("u");
  });

  it("undoes to the start", async () => {
    const before = [paragraph("see ")];
    const editor = makeEditor(JSON.parse(JSON.stringify(before)));
    Transforms.select(editor, Editor.end(editor, []));
    await typeKeys(editor, "[y](u)");
    while (editor.history.undos.length > 0) {
      HistoryEditor.undo(editor as HistoryEditor);
      await flush();
    }
    expect(editor.children).toEqual(before);
  });
});

describe("a ( typed where no scaffold is waiting", () => {
  const caretBeforeClose = (editor: Editor) => {
    const end = Editor.end(editor, []);
    Transforms.select(editor, { path: end.path, offset: end.offset - 1 });
  };

  it("stays in ordinary text", async () => {
    const editor = makeEditor([paragraph("f")]);
    Transforms.select(editor, Editor.end(editor, []));
    await typeKeys(editor, "(x)");
    expect(editor.children).toEqual([paragraph("f(x)")]);
  });

  it("stays between ] and ( when no ) follows", async () => {
    const editor = makeEditor([paragraph("a](")]);
    Transforms.select(editor, Editor.end(editor, []));
    await typeKeys(editor, "(");
    expect(editor.children).toEqual([paragraph("a]((")]);
  });

  it("stays in a code block", async () => {
    const editor = makeEditor([
      { type: "code-block", children: [{ text: "f[0]()" }] },
    ]);
    caretBeforeClose(editor);
    await typeKeys(editor, "(");
    expect(Editor.string(editor, [])).toBe("f[0](()");
  });

  it("stays in inline code", async () => {
    const editor = makeEditor([
      { type: "paragraph", children: [{ text: "f[0]()", code: true }] },
    ]);
    caretBeforeClose(editor);
    await typeKeys(editor, "(");
    expect(Editor.string(editor, [])).toBe("f[0](()");
  });

  it("stays in open math source", async () => {
    const editor = makeEditor([paragraph("$a[b]()")]);
    caretBeforeClose(editor);
    await typeKeys(editor, "(");
    expect(Editor.string(editor, [])).toBe("$a[b](()");
  });
});
