import { act, render } from "@testing-library/react";
import { createEditor, type Descendant, Editor, Node, Transforms } from "slate";
import { HistoryEditor, withHistory } from "slate-history";
import { Editable, ReactEditor, Slate, withReact } from "slate-react";
import { describe, expect, it } from "vitest";
import { markdownToSlate, slateToMarkdown } from "#/editor/convert";
import { withOutliner } from "#/editor/plugins/withOutliner";
import { withSchema } from "#/editor/schema/withSchema";
import { withMarkdownPaste } from "../withMarkdownPaste";

type El = { type?: string; children?: El[] };

function fromMd(md: string): Editor {
  const editor = withMarkdownPaste(
    withReact(withHistory(withOutliner(withSchema(createEditor())))),
  );
  editor.children = markdownToSlate(md);
  Editor.normalize(editor, { force: true });
  return editor;
}

const toMd = (editor: Editor) => slateToMarkdown(editor.children);

function pathOf(editor: Editor, text: string, type = "paragraph") {
  for (const [node, path] of Node.nodes(editor)) {
    if ((node as El).type === type && Node.string(node) === text) return path;
  }
  throw new Error(`no ${type} ${text}`);
}

/** The part of the block holding `text` from `from` to `to`, as vim's y and x do. */
function fragmentOf(
  editor: Editor,
  text: string,
  type: string,
  from: number,
  to: number,
): Descendant[] {
  const leaf = [...pathOf(editor, text, type), 0];
  return Editor.fragment(editor, {
    anchor: { path: leaf, offset: from },
    focus: { path: leaf, offset: to },
  });
}

function caret(editor: Editor, text: string, offset: number) {
  Transforms.select(editor, { path: [...pathOf(editor, text), 0], offset });
}

describe("part of one block's text, from inside a list item", () => {
  it("from a code block, stays on the caret's line in an item", () => {
    const editor = fromMd("- ab\n\n  ```\n  cd\n  ```\n- zz");
    const fragment = fragmentOf(editor, "cd", "code-block", 0, 1);
    caret(editor, "zz", 1);
    Transforms.insertFragment(editor, fragment);
    expect(toMd(editor)).toBe("* ab\n  ```\n  cd\n  ```\n* zcz\n");
  });

  it("from a code block, stays on the caret's line in a paragraph", () => {
    const editor = fromMd("- ab\n\n  ```\n  cd\n  ```\n\nzz");
    const fragment = fragmentOf(editor, "cd", "code-block", 0, 1);
    caret(editor, "zz", 1);
    Transforms.insertFragment(editor, fragment);
    expect(Node.string(editor.children[editor.children.length - 1])).toBe(
      "zcz",
    );
  });

  it("from a quote, stays on the caret's line", () => {
    const editor = fromMd("- ab\n\n  > cd\n- zz");
    const fragment = fragmentOf(editor, "cd", "paragraph", 0, 1);
    caret(editor, "zz", 1);
    Transforms.insertFragment(editor, fragment);
    expect(toMd(editor)).toBe("* ab\n  > cd\n* zcz\n");
  });

  it("from a later paragraph, stays on the caret's line", () => {
    const editor = fromMd("- ab\n\n  cd\n- zz");
    const fragment = fragmentOf(editor, "cd", "paragraph", 0, 1);
    caret(editor, "zz", 1);
    Transforms.insertFragment(editor, fragment);
    expect(toMd(editor)).toBe("* ab\n\n  cd\n* zcz\n");
  });

  it("from a nested code block, stays on the caret's line", () => {
    const editor = fromMd("- top\n  - ab\n\n    ```\n    cd\n    ```\n- zz");
    const fragment = fragmentOf(editor, "cd", "code-block", 0, 1);
    caret(editor, "zz", 1);
    Transforms.insertFragment(editor, fragment);
    expect(Node.string(pathNode(editor, "zcz"))).toBe("zcz");
  });

  it("at the start and end of the caret's line, stays on it", () => {
    for (const [offset, want] of [
      [0, "czz"],
      [2, "zzc"],
    ] as const) {
      const editor = fromMd("- ab\n\n  ```\n  cd\n  ```\n- zz");
      const fragment = fragmentOf(editor, "cd", "code-block", 0, 1);
      caret(editor, "zz", offset);
      Transforms.insertFragment(editor, fragment);
      expect(Node.string(pathNode(editor, want))).toBe(want);
    }
  });

  it("with several lines of code, keeps them as text on the line", () => {
    const editor = fromMd("- ab\n\n  ```\n  c1\n  c2\n  ```\n- zz");
    const fragment = fragmentOf(editor, "c1\nc2", "code-block", 0, 5);
    caret(editor, "zz", 1);
    Transforms.insertFragment(editor, fragment);
    expect(Node.string(pathNode(editor, "zc1\nc2z"))).toBe("zc1\nc2z");
  });

  it("is one undo", async () => {
    const editor = fromMd("- ab\n\n  ```\n  cd\n  ```\n- zz");
    const start = JSON.stringify(editor.children);
    const fragment = fragmentOf(editor, "cd", "code-block", 0, 1);
    caret(editor, "zz", 1);
    await Promise.resolve();
    Transforms.insertFragment(editor, fragment);
    await Promise.resolve();
    HistoryEditor.undo(editor as HistoryEditor);
    await Promise.resolve();
    expect(JSON.stringify(editor.children)).toBe(start);
  });
});

function pathNode(editor: Editor, text: string) {
  return Node.get(editor, pathOf(editor, text));
}

describe("what still pastes as blocks", () => {
  it("a code block with another block in the fragment stays a code block", () => {
    const editor = fromMd("- ab\n\n  ```\n  cd\n  ```\n- zz");
    Transforms.select(editor, {
      anchor: { path: [...pathOf(editor, "ab"), 0], offset: 0 },
      focus: { path: [...pathOf(editor, "cd", "code-block"), 0], offset: 2 },
    });
    const fragment = editor.getFragment();
    caret(editor, "zz", 2);
    Transforms.insertFragment(editor, fragment);
    expect(toMd(editor)).toBe(
      "* ab\n  ```\n  cd\n  ```\n* zzab\n  ```\n  cd\n  ```\n",
    );
  });

  it("a pasted Markdown item with a line and a fence keeps the fence", () => {
    const editor = fromMd("- zz");
    caret(editor, "zz", 2);
    editor.insertData({
      getData: (t: string) =>
        t === "text/plain" ? "- x\n\n  ```\n  code\n  ```" : "",
    } as unknown as DataTransfer);
    expect(toMd(editor)).toBe("* zzx\n  ```\n  code\n  ```\n");
  });

  it("one code block's text into an empty item stays a code block", () => {
    // The fragment cannot show it was only part of the block: see isOneBlockOfText.
    const editor = fromMd("- ab\n\n  ```\n  cd\n  ```\n- zz");
    const fragment = fragmentOf(editor, "cd", "code-block", 0, 2);
    const zz = pathOf(editor, "zz");
    Transforms.delete(editor, { at: Editor.range(editor, zz) });
    Transforms.select(editor, Editor.start(editor, zz));
    Transforms.insertFragment(editor, fragment);
    const types = (editor.children[0] as El).children?.[1].children?.map(
      (c) => c.type,
    );
    expect(types).toContain("code-block");
  });

  it("a divider in an item stays a divider", () => {
    const editor = fromMd("- zz");
    caret(editor, "zz", 1);
    Transforms.insertFragment(editor, markdownToSlate("- ---"));
    const types = (editor.children[0] as El).children?.[0].children?.map(
      (c) => c.type,
    );
    expect(types).toContain("thematic-break");
  });
});

/** Copy and paste through slate-dom's own clipboard code on a rendered editor. */
describe("copying from a rendered editor", () => {
  function clipboard() {
    const items: Record<string, string> = {};
    return {
      items,
      setData: (type: string, value: string) => {
        items[type] = value;
      },
      getData: (type: string) => items[type] ?? "",
    } as unknown as DataTransfer & { items: Record<string, string> };
  }

  it("carries the same fragment, and pastes on the caret's line", () => {
    const editor = fromMd("- ab\n\n  ```\n  cd\n  ```\n- zz");
    const initial = editor.children;
    render(
      <Slate editor={editor} initialValue={initial}>
        <Editable
          renderElement={({ attributes, children }) => (
            <div {...attributes}>{children}</div>
          )}
        />
      </Slate>,
    );
    const leaf = [...pathOf(editor, "cd", "code-block"), 0];
    const data = clipboard();
    act(() => {
      Transforms.select(editor, {
        anchor: { path: leaf, offset: 0 },
        focus: { path: leaf, offset: 1 },
      });
      ReactEditor.setFragmentData(editor, data);
    });
    expect(data.items["application/x-slate-fragment"]).toBeTruthy();
    const copied = JSON.parse(
      decodeURIComponent(
        window.atob(data.items["application/x-slate-fragment"]),
      ),
    );
    expect(copied).toEqual([
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            children: [{ type: "code-block", children: [{ text: "c" }] }],
          },
        ],
      },
    ]);
    act(() => {
      caret(editor, "zz", 1);
      ReactEditor.insertData(editor, data);
    });
    expect(toMd(editor)).toBe("* ab\n  ```\n  cd\n  ```\n* zcz\n");
  });
});
