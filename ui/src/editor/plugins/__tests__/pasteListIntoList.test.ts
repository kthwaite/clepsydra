import { createEditor, type Descendant, Editor, Node, Transforms } from "slate";
import { HistoryEditor, withHistory } from "slate-history";
import { withReact } from "slate-react";
import { describe, expect, it } from "vitest";
import { markdownToSlate, slateToMarkdown } from "#/editor/convert";
import { withOutliner } from "#/editor/plugins/withOutliner";
import { withSchema } from "#/editor/schema/withSchema";
import { insertMarkdown } from "#/editor/transforms/insertMarkdown";
import { withMarkdownPaste } from "../withMarkdownPaste";

type El = { type?: string; checked?: boolean; children?: El[] };

function fromMd(md: string): Editor {
  const editor = withMarkdownPaste(
    withReact(withHistory(withOutliner(withSchema(createEditor())))),
  );
  editor.children = markdownToSlate(md);
  Editor.normalize(editor, { force: true });
  return editor;
}

const toMd = (editor: Editor) => slateToMarkdown(editor.children);

/**
 * One line per block, two spaces per list depth: `b`/`n` an item's own line,
 * `p` any other paragraph, `<type>` an item not led by a paragraph.
 */
function view(nodes: Descendant[], depth = 0): string[] {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  for (const node of nodes as El[]) {
    if (node.type === "bulleted-list" || node.type === "numbered-list") {
      const marker = node.type === "bulleted-list" ? "b" : "n";
      for (const item of node.children ?? []) {
        const [lead, ...rest] = item.children ?? [];
        const box =
          item.checked === undefined ? "" : item.checked ? "[x]" : "[ ]";
        const text =
          lead?.type === "paragraph"
            ? Node.string(lead as Node)
            : `<${lead?.type}>`;
        lines.push(`${indent}${marker}${box} ${text}`);
        lines.push(...view(rest as Descendant[], depth + 1));
      }
    } else if (node.type === "blockquote") {
      lines.push(...view(node.children as Descendant[], depth + 1));
    } else if (node.type === "list-item") {
      lines.push(`${indent}<stray item> ${Node.string(node as Node)}`);
    } else {
      const tag = node.type === "paragraph" ? "p" : node.type;
      lines.push(`${indent}${tag} ${Node.string(node as Node)}`);
    }
  }
  return lines;
}

function pathOf(editor: Editor, text: string) {
  for (const [node, path] of Node.nodes(editor)) {
    if (
      ((node as El).type === "paragraph" || (node as El).type === "heading") &&
      Node.string(node) === text
    ) {
      return path;
    }
  }
  throw new Error(`no line ${text} in ${view(editor.children).join(" | ")}`);
}

function caret(editor: Editor, text: string, offset = 0) {
  Transforms.select(editor, { path: [...pathOf(editor, text), 0], offset });
}

function emptyLine(editor: Editor, text: string) {
  const path = pathOf(editor, text);
  Transforms.delete(editor, { at: Editor.range(editor, path) });
  Transforms.select(editor, Editor.start(editor, path));
}

function paste(editor: Editor, md: string) {
  editor.insertData({
    getData: (type: string) => (type === "text/plain" ? md : ""),
    types: ["text/plain"],
  } as unknown as DataTransfer);
}

describe("pasting a list at the end of an item", () => {
  it("adds the later items as siblings", () => {
    const editor = fromMd("- aaa\n- bbb");
    caret(editor, "aaa", 3);
    paste(editor, "- x\n- y\n- z");
    expect(view(editor.children)).toEqual(["b aaax", "b y", "b z", "b bbb"]);
    expect(toMd(editor)).toBe("* aaax\n* y\n* z\n* bbb\n");
  });

  it("keeps pasted kids nested under their item", () => {
    const editor = fromMd("- aaa");
    caret(editor, "aaa", 3);
    paste(editor, "- x\n  - kid\n- y");
    expect(view(editor.children)).toEqual(["b aaax", "  b kid", "b y"]);
  });

  it("keeps the host's kids after what was pasted", () => {
    const editor = fromMd("- aaa\n  - old\n- bbb");
    caret(editor, "aaa", 3);
    paste(editor, "- x\n- y");
    expect(view(editor.children)).toEqual([
      "b aaax",
      "b y",
      "  b old",
      "b bbb",
    ]);
  });

  it("joins a pasted kid and the host's kid in one list", () => {
    const editor = fromMd("- aaa\n  - old");
    caret(editor, "aaa", 3);
    paste(editor, "- x\n  - y");
    expect(view(editor.children)).toEqual(["b aaax", "  b y", "  b old"]);
    expect(
      (editor.children[0] as unknown as El).children?.[0].children,
    ).toHaveLength(2);
  });

  it("stays at a nested host's depth", () => {
    const editor = fromMd("- top\n  - aaa\n  - bbb");
    caret(editor, "aaa", 3);
    paste(editor, "- x\n- y");
    expect(view(editor.children)).toEqual([
      "b top",
      "  b aaax",
      "  b y",
      "  b bbb",
    ]);
  });

  it("puts pasted items in the host's list", () => {
    const editor = fromMd("1. aaa\n2. bbb");
    caret(editor, "aaa", 3);
    paste(editor, "- x\n- y");
    expect(view(editor.children)).toEqual(["n aaax", "n y", "n bbb"]);
  });

  it("keeps the checkboxes of pasted later items", () => {
    const editor = fromMd("- aaa");
    caret(editor, "aaa", 3);
    paste(editor, "- [ ] x\n- [x] y");
    expect(view(editor.children)).toEqual(["b aaax", "b[x] y"]);
  });

  it("keeps a pasted item's later paragraph in that item", () => {
    const editor = fromMd("- aaa");
    caret(editor, "aaa", 3);
    paste(editor, "- x\n\n  par\n- y");
    expect(view(editor.children)).toEqual(["b aaax", "  p par", "b y"]);
  });

  it("does not throw on an empty pasted bullet", () => {
    const editor = fromMd("- aaa");
    caret(editor, "aaa", 3);
    paste(editor, "- x\n-");
    expect(view(editor.children)).toEqual(["b aaax", "b "]);
  });
});

describe("pasting a list at the start or middle of an item", () => {
  it("at the start, gives each pasted item its own bullet", () => {
    const editor = fromMd("- aaa");
    caret(editor, "aaa", 0);
    paste(editor, "- x\n- y");
    expect(view(editor.children)).toEqual(["b x", "b yaaa"]);
  });

  it("mid-text, keeps the last pasted item a bullet with the tail", () => {
    const editor = fromMd("- aaa");
    caret(editor, "aaa", 1);
    paste(editor, "- x\n- y");
    expect(view(editor.children)).toEqual(["b ax", "b yaa"]);
  });

  it("mid-text, keeps a pasted kid nested with the tail", () => {
    const editor = fromMd("- aaa");
    caret(editor, "aaa", 1);
    paste(editor, "- x\n  - y");
    expect(view(editor.children)).toEqual(["b ax", "  b yaa"]);
  });

  it("mid-text, keeps three items in order", () => {
    const editor = fromMd("- aaa\n- bbb");
    caret(editor, "aaa", 1);
    paste(editor, "- x\n- y\n- z");
    expect(view(editor.children)).toEqual(["b ax", "b y", "b zaa", "b bbb"]);
  });

  it("mid-text, keeps the host's kids after the tail", () => {
    const editor = fromMd("- aaa\n  - old");
    caret(editor, "aaa", 1);
    paste(editor, "- x\n- y");
    expect(view(editor.children)).toEqual(["b ax", "b yaa", "  b old"]);
  });

  it("gives a tail after a pasted code block its own paragraph", () => {
    const editor = fromMd("- aaa");
    caret(editor, "aaa", 1);
    paste(editor, "- x\n\n  ```\n  code\n  ```");
    expect(view(editor.children)).toEqual([
      "b ax",
      "  code-block code",
      "  p aa",
    ]);
  });

  it("keeps the host's checkbox on the first line", () => {
    const editor = fromMd("- [x] aaa");
    caret(editor, "aaa", 1);
    paste(editor, "- [ ] x\n- y");
    expect(view(editor.children)).toEqual(["b[x] ax", "b yaa"]);
  });
});

describe("the caret after pasting a list", () => {
  it("is before the tail, so typing lands between", () => {
    const editor = fromMd("- aaa");
    caret(editor, "aaa", 1);
    paste(editor, "- x\n- y");
    Editor.insertText(editor, "Z");
    expect(view(editor.children)).toEqual(["b ax", "b yZaa"]);
  });

  it("is at the pasted text's end in an empty item", () => {
    const editor = fromMd("- bbb");
    emptyLine(editor, "bbb");
    paste(editor, "- x\n- y");
    Editor.insertText(editor, "Z");
    expect(view(editor.children)).toEqual(["b x", "b yZ"]);
  });

  it("is after a wikilink ending the last pasted item", () => {
    const editor = fromMd("- aaa");
    caret(editor, "aaa", 3);
    paste(editor, "- x\n- [[Foo]]");
    Editor.insertText(editor, "Z");
    expect(toMd(editor)).toBe("* aaax\n* [[Foo]]Z\n");
  });
});

describe("pasting into an empty item", () => {
  it("adds no second bullet", () => {
    const editor = fromMd("- aaa\n- bbb");
    emptyLine(editor, "bbb");
    paste(editor, "- x\n- y");
    expect(view(editor.children)).toEqual(["b aaa", "b x", "b y"]);
  });

  it("takes one pasted item as its text", () => {
    const editor = fromMd("- aaa\n- bbb");
    emptyLine(editor, "bbb");
    paste(editor, "- x");
    expect(view(editor.children)).toEqual(["b aaa", "b x"]);
  });

  it("takes a pasted item's checkbox and metadata", () => {
    const editor = fromMd("- bbb");
    emptyLine(editor, "bbb");
    paste(editor, "- [x] y [due:: 2026-11-04] ^abc123defg");
    expect(toMd(editor)).toBe("* [x] y [due:: 2026-11-04] ^abc123defg\n");
  });

  it("keeps its own checkbox over a pasted one", () => {
    const editor = fromMd("- [ ] bbb");
    emptyLine(editor, "bbb");
    paste(editor, "- [x] y");
    expect(view(editor.children)).toEqual(["b[ ] y"]);
  });

  it("keeps its kids after what was pasted", () => {
    const editor = fromMd("- bbb\n  - old");
    emptyLine(editor, "bbb");
    paste(editor, "- x\n- y");
    expect(view(editor.children)).toEqual(["b x", "b y", "  b old"]);
  });

  it("takes a copied nested item as one bullet", () => {
    const editor = fromMd("- aaa\n  - kid\n- bbb");
    const kid = pathOf(editor, "kid");
    Transforms.select(editor, Editor.range(editor, kid));
    const fragment = editor.getFragment();
    emptyLine(editor, "bbb");
    Transforms.insertFragment(editor, fragment);
    expect(view(editor.children)).toEqual(["b aaa", "  b kid", "b kid"]);
  });

  it("takes a copy from a kid to a parent at one depth", () => {
    const editor = fromMd("- aaa\n  - kid\n- bbb\n- ccc");
    Transforms.select(editor, {
      anchor: Editor.start(editor, pathOf(editor, "kid")),
      focus: Editor.end(editor, pathOf(editor, "bbb")),
    });
    const fragment = editor.getFragment();
    emptyLine(editor, "ccc");
    Transforms.insertFragment(editor, fragment);
    expect(view(editor.children)).toEqual([
      "b aaa",
      "  b kid",
      "b bbb",
      "b kid",
      "b bbb",
    ]);
  });
});

describe("pasting a list over a selection", () => {
  it("replaces a whole item at its depth", () => {
    const editor = fromMd("- aaa\n- bbb");
    Transforms.select(editor, Editor.range(editor, pathOf(editor, "bbb")));
    paste(editor, "- x\n- y");
    expect(view(editor.children)).toEqual(["b aaa", "b x", "b y"]);
  });

  it("replaces a span of items, joining the tail", () => {
    const editor = fromMd("- aaa\n- bbb\n- ccc");
    Transforms.select(editor, {
      anchor: { path: [...pathOf(editor, "aaa"), 0], offset: 1 },
      focus: { path: [...pathOf(editor, "ccc"), 0], offset: 1 },
    });
    paste(editor, "- x\n- y");
    expect(view(editor.children)).toEqual(["b ax", "b ycc"]);
  });

  it("replaces an empty line selected up to the next line", () => {
    const editor = fromMd("- bbb\n  - kid");
    const line = pathOf(editor, "bbb");
    Transforms.insertNodes(
      editor,
      { type: "paragraph", children: [{ text: "" }] } as Descendant,
      { at: [0] },
    );
    Transforms.select(editor, {
      anchor: Editor.start(editor, [0]),
      focus: Editor.start(editor, [1, ...line.slice(1)]),
    });
    paste(editor, "- x\n- y");
    expect(view(editor.children)).toEqual(["b x", "b y", "b bbb", "  b kid"]);
  });

  it("does not throw when the deleted span ends at a marked item's start", () => {
    const editor = fromMd("- one\n- two**bold**");
    Transforms.select(editor, {
      anchor: Editor.end(editor, pathOf(editor, "one")),
      focus: Editor.start(editor, pathOf(editor, "twobold")),
    });
    paste(editor, "x\n\n- y");
    expect(view(editor.children).join("|")).toContain("b onex");
    expect(view(editor.children).join("|")).toContain("b ytwobold");
  });

  it("still pastes when the replaced text ends in a wikilink", () => {
    const editor = fromMd("- aa [[Foo]]");
    Transforms.select(editor, Editor.range(editor, [0, 0, 0]));
    paste(editor, "- x\n- y");
    expect(view(editor.children)).toEqual(["b x", "b y"]);
  });

  it("still pastes when the selection ends in an empty kid", () => {
    const editor = fromMd("- aaa\n  - bbb");
    emptyLine(editor, "bbb");
    Transforms.select(editor, {
      anchor: { path: [...pathOf(editor, "aaa"), 0], offset: 1 },
      focus: Editor.start(editor, [0, 0, 1, 0, 0]),
    });
    paste(editor, "- x\n- y");
    expect(view(editor.children)).toEqual(["b ax", "b y"]);
  });

  it("replaces a nested item at its depth", () => {
    const editor = fromMd("- aaa\n  - kid\n- bbb");
    Transforms.select(editor, Editor.range(editor, pathOf(editor, "kid")));
    paste(editor, "- x\n  - y");
    expect(view(editor.children)).toEqual([
      "b aaa",
      "  b x",
      "    b y",
      "b bbb",
    ]);
  });
});

describe("pasting a list into a paragraph", () => {
  it("makes a real list after the joined first line", () => {
    const editor = fromMd("aaa\n\nzzz");
    caret(editor, "aaa", 3);
    paste(editor, "- x\n- y\n- z");
    expect(toMd(editor)).toBe("aaax\n\n* y\n* z\n\nzzz\n");
  });

  it("joins the tail to the last item", () => {
    const editor = fromMd("aaa");
    caret(editor, "aaa", 1);
    paste(editor, "- x\n- y");
    expect(view(editor.children)).toEqual(["p ax", "b yaa"]);
  });

  it("at the paragraph's start, makes the whole list", () => {
    const editor = fromMd("aaa");
    caret(editor, "aaa", 0);
    paste(editor, "- x\n- y");
    expect(view(editor.children)).toEqual(["b x", "b yaaa"]);
  });

  it("keeps a first item's kids in a list", () => {
    const editor = fromMd("aaa");
    caret(editor, "aaa", 3);
    paste(editor, "- x\n  - y");
    expect(toMd(editor)).toBe("aaax\n\n* y\n");
  });

  it("does not throw on an empty pasted bullet", () => {
    const editor = fromMd("aaa");
    caret(editor, "aaa", 3);
    paste(editor, "- x\n-");
    expect(view(editor.children)).toEqual(["p aaax", "b "]);
  });

  it("inside a quote stays in the quote", () => {
    const editor = fromMd("> aaa");
    caret(editor, "aaa", 3);
    paste(editor, "- x\n- y");
    expect(toMd(editor)).toBe("> aaax\n>\n> * y\n");
  });

  it("at an item's later paragraph, nests the list in that item", () => {
    const editor = fromMd("- aaa\n\n  par\n- bbb");
    caret(editor, "par", 3);
    paste(editor, "- x\n- y");
    expect(view(editor.children)).toEqual([
      "b aaa",
      "  p parx",
      "  b y",
      "b bbb",
    ]);
  });

  it("with no list in the fragment is as before", () => {
    const editor = fromMd("aaa");
    caret(editor, "aaa", 1);
    paste(editor, "x\n\ny");
    expect(view(editor.children)).toEqual(["p ax", "p yaa"]);
  });
});

describe("mixed fragments in an item", () => {
  it("makes a later list's items siblings", () => {
    const editor = fromMd("- aaa");
    caret(editor, "aaa", 3);
    paste(editor, "x\n\n- y");
    expect(view(editor.children)).toEqual(["b aaax", "b y"]);
  });

  it("keeps a later paragraph in the current item", () => {
    const editor = fromMd("- aaa");
    caret(editor, "aaa", 3);
    paste(editor, "- x\n\ny");
    expect(view(editor.children)).toEqual(["b aaax", "  p y"]);
  });

  it("in an empty item leaves no list-first item", () => {
    const editor = fromMd("- aaa");
    emptyLine(editor, "aaa");
    paste(editor, "- x\n\ny");
    expect(view(editor.children)).toEqual(["b x", "  p y"]);
  });
});

describe("what stays as it was", () => {
  it("a single pasted item merges inline", () => {
    const editor = fromMd("- aaa");
    caret(editor, "aaa", 1);
    paste(editor, "- x");
    expect(view(editor.children)).toEqual(["b axaa"]);
  });

  it("two paragraphs in an item stay one item", () => {
    const editor = fromMd("- aaa");
    caret(editor, "aaa", 1);
    paste(editor, "x\n\ny");
    expect(view(editor.children)).toEqual(["b ax", "  p yaa"]);
  });

  it("a list into an empty paragraph is that list", () => {
    const editor = fromMd("pre\n\nmid\n\npost");
    emptyLine(editor, "mid");
    paste(editor, "- x\n  - y\n- z");
    expect(view(editor.children)).toEqual([
      "p pre",
      "b x",
      "  b y",
      "b z",
      "p post",
    ]);
  });

  it("a code block takes pasted text literally", () => {
    const editor = fromMd("```\nabc\n```");
    Transforms.select(editor, { path: [0, 0], offset: 3 });
    paste(editor, "- x\n- y");
    expect(Node.string(editor.children[0])).toBe("abc- x\n- y");
  });
});

describe("other routes to insertFragment", () => {
  it("insertMarkdown gets the same result", () => {
    const editor = fromMd("- aaa");
    caret(editor, "aaa", 3);
    insertMarkdown(editor, "- x\n- y");
    expect(view(editor.children)).toEqual(["b aaax", "b y"]);
  });

  it("Transforms.insertFragment, as vim put uses, gets the same result", () => {
    const editor = fromMd("- aaa");
    caret(editor, "aaa", 3);
    Transforms.insertFragment(editor, markdownToSlate("- x\n- y"));
    expect(view(editor.children)).toEqual(["b aaax", "b y"]);
  });

  it("a caret inside a link splits the link around the paste", () => {
    const editor = fromMd("- [link](https://x.io)");
    Transforms.select(editor, { path: [0, 0, 0, 1, 0], offset: 2 });
    paste(editor, "- x\n- y");
    expect(view(editor.children)).toEqual(["b lix", "b ynk"]);
  });
});

describe("history", () => {
  it("one undo reverses a paste over a selection ending at a line start, keeping prior typing", async () => {
    const editor = fromMd("- aaa\n- bbb\n- ccc");
    caret(editor, "ccc", 3);
    await Promise.resolve();
    Editor.insertText(editor, "T");
    await Promise.resolve();
    const typed = JSON.stringify(editor.children);
    Transforms.select(editor, {
      anchor: Editor.start(editor, pathOf(editor, "aaa")),
      focus: Editor.start(editor, pathOf(editor, "bbb")),
    });
    await Promise.resolve();
    paste(editor, "- x\n- y");
    await Promise.resolve();
    expect(view(editor.children)).toEqual(["b x", "b y", "b bbb", "b cccT"]);
    HistoryEditor.undo(editor as HistoryEditor);
    await Promise.resolve();
    expect(JSON.stringify(editor.children)).toBe(typed);
  });

  it("one undo reverses one paste, one redo repeats it", async () => {
    const editor = fromMd("- aaa\n  - old\n- bbb");
    const start = JSON.stringify(editor.children);
    caret(editor, "aaa", 1);
    await Promise.resolve();
    paste(editor, "- x\n  - k\n- y");
    await Promise.resolve();
    const after = JSON.stringify(editor.children);
    expect(view(editor.children)).toEqual([
      "b ax",
      "  b k",
      "b yaa",
      "  b old",
      "b bbb",
    ]);
    HistoryEditor.undo(editor as HistoryEditor);
    await Promise.resolve();
    expect(JSON.stringify(editor.children)).toBe(start);
    HistoryEditor.redo(editor as HistoryEditor);
    await Promise.resolve();
    expect(JSON.stringify(editor.children)).toBe(after);
  });
});
