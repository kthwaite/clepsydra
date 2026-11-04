import { createEditor, type Descendant, Editor, Node, Transforms } from "slate";
import { HistoryEditor, withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { markdownToSlate, slateToMarkdown } from "#/editor/convert";
import { withOutliner } from "#/editor/plugins/withOutliner";
import { withSchema } from "#/editor/schema/withSchema";
import { applySelectionList } from "../blockConversions";

type ListType = "bulleted-list" | "numbered-list";
type El = {
  type?: string;
  checked?: boolean;
  children?: El[];
};

function fromMd(md: string): Editor {
  const editor = withHistory(withOutliner(withSchema(createEditor())));
  editor.children = markdownToSlate(md);
  Editor.normalize(editor, { force: true });
  return editor;
}

const toMd = (editor: Editor) => slateToMarkdown(editor.children);

/**
 * One line per block, two spaces per list depth: `b`/`n` an item's own line,
 * `p` any other paragraph, `<type>` an item that does not lead with a paragraph.
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
      Node.isNode(node) &&
      ((node as El).type === "paragraph" || (node as El).type === "heading") &&
      Node.string(node) === text
    ) {
      return path;
    }
  }
  throw new Error(`no line ${text}`);
}

function select(editor: Editor, a: string, ao: number, b: string, bo: number) {
  Transforms.select(editor, {
    anchor: { path: [...pathOf(editor, a), 0], offset: ao },
    focus: { path: [...pathOf(editor, b), 0], offset: bo },
  });
}

/** What SelectionBubbleMenu's list buttons run. */
function press(editor: Editor, list: ListType = "bulleted-list") {
  Editor.withoutNormalizing(editor, () => applySelectionList(editor, list));
}

describe("the bubble's list button on an item with kids", () => {
  it("leaves the kids under the item", () => {
    const editor = fromMd("- aaa\n  - kid\n- bbb");
    select(editor, "aaa", 0, "aaa", 3);
    press(editor);
    expect(view(editor.children)).toEqual(["b aaa", "  b kid", "b bbb"]);
  });

  it("leaves the item's later blocks in the item", () => {
    const editor = fromMd("- aaa\n\n  par\n- bbb");
    select(editor, "aaa", 0, "aaa", 3);
    press(editor);
    expect(view(editor.children)).toEqual(["b aaa", "  p par", "b bbb"]);
  });

  it("leaves a soft line in the item", () => {
    const editor = fromMd("- aaa\n  more\n- bbb");
    const line = "aaa\nmore";
    select(editor, line, 0, line, 3);
    press(editor);
    expect(toMd(editor)).toBe("* aaa\n  more\n* bbb\n");
  });

  it("moves the kids with the item when the type changes", () => {
    const editor = fromMd("- aaa\n  - kid\n- bbb");
    select(editor, "aaa", 0, "aaa", 3);
    press(editor, "numbered-list");
    expect(view(editor.children)).toEqual(["n aaa", "  b kid", "b bbb"]);
  });
});

describe("the bubble's list button across depths", () => {
  it("from a parent to its kid changes nothing", () => {
    const editor = fromMd("- aaa\n  - kid\n- bbb");
    select(editor, "aaa", 1, "kid", 2);
    press(editor);
    expect(view(editor.children)).toEqual(["b aaa", "  b kid", "b bbb"]);
  });

  it("from a kid to the next parent changes nothing", () => {
    const editor = fromMd("- aaa\n  - kid\n- bbb");
    select(editor, "kid", 1, "bbb", 2);
    press(editor);
    expect(view(editor.children)).toEqual(["b aaa", "  b kid", "b bbb"]);
  });

  it("from a grandchild to a kid changes nothing", () => {
    const editor = fromMd("- aaa\n  - kid\n    - gra\n  - kod\n- bbb");
    select(editor, "gra", 1, "kod", 2);
    press(editor);
    expect(view(editor.children)).toEqual([
      "b aaa",
      "  b kid",
      "    b gra",
      "  b kod",
      "b bbb",
    ]);
  });

  it("changing type keeps every line at its depth", () => {
    const editor = fromMd("- aaa\n  - kid\n- bbb");
    select(editor, "aaa", 1, "bbb", 2);
    press(editor, "numbered-list");
    expect(view(editor.children)).toEqual(["n aaa", "  n kid", "n bbb"]);
    expect(editor.children).toHaveLength(1);
  });

  it("changing type on a kid and a parent keeps them at their depths", () => {
    const editor = fromMd("- aaa\n  - kid\n- bbb\n- ccc");
    select(editor, "kid", 1, "bbb", 2);
    press(editor, "numbered-list");
    expect(view(editor.children)).toEqual([
      "b aaa",
      "  n kid",
      "n bbb",
      "b ccc",
    ]);
  });
});

describe("any selection in a list of bullets, same type", () => {
  const md = [
    "- aaa",
    "  - kid",
    "    - gra",
    "  - kod",
    "- bbb",
    "- [x] ccc",
    "  - [ ] sub",
  ].join("\n");
  const lines = ["aaa", "kid", "gra", "kod", "bbb", "ccc", "sub"];

  for (const a of lines) {
    for (const b of lines) {
      it(`${a} to ${b} changes nothing`, () => {
        const editor = fromMd(md);
        const before = JSON.stringify(editor.children);
        select(editor, a, 1, b, 2);
        press(editor);
        expect(JSON.stringify(editor.children)).toBe(before);
      });
    }
  }
});

describe("the bubble's list button and an item's own data", () => {
  it("keeps checkboxes", () => {
    const editor = fromMd("- [x] aaa\n- [ ] bbb");
    select(editor, "aaa", 0, "bbb", 3);
    press(editor);
    expect(view(editor.children)).toEqual(["b[x] aaa", "b[ ] bbb"]);
  });

  it("keeps properties and the block id", () => {
    const editor = fromMd("- [ ] aaa [due:: 2026-11-04] ^abc123defg\n- bbb");
    select(editor, "aaa", 0, "bbb", 3);
    press(editor);
    expect(toMd(editor)).toBe(
      "* [ ] aaa [due:: 2026-11-04] ^abc123defg\n* bbb\n",
    );
  });

  it("keeps them when the type changes", () => {
    const editor = fromMd("- [x] aaa [due:: 2026-11-04] ^abc123defg\n- bbb");
    select(editor, "aaa", 0, "aaa", 3);
    press(editor, "numbered-list");
    expect(toMd(editor)).toBe(
      "1. [x] aaa [due:: 2026-11-04] ^abc123defg\n\n* bbb\n",
    );
  });
});

describe("a selection ending at the start of the next line", () => {
  it("leaves the next bullet alone", () => {
    const editor = fromMd("- aaa\n- bbb\n- ccc");
    select(editor, "aaa", 0, "bbb", 0);
    press(editor);
    expect(view(editor.children)).toEqual(["b aaa", "b bbb", "b ccc"]);
  });

  it("changes only the selected bullet's type", () => {
    const editor = fromMd("- aaa\n- bbb\n- ccc");
    select(editor, "aaa", 0, "bbb", 0);
    press(editor, "numbered-list");
    expect(view(editor.children)).toEqual(["n aaa", "b bbb", "b ccc"]);
  });

  it("leaves the next paragraph alone", () => {
    const editor = fromMd("aaa\n\nbbb");
    select(editor, "aaa", 0, "bbb", 0);
    press(editor);
    expect(view(editor.children)).toEqual(["b aaa", "p bbb"]);
  });

  it("leaves a bullet after a paragraph alone", () => {
    const editor = fromMd("aaa\n\n- bbb\n- ccc");
    select(editor, "aaa", 0, "bbb", 0);
    press(editor);
    expect(view(editor.children)).toEqual(["b aaa", "b bbb", "b ccc"]);
  });
});

describe("lines that are not list items yet", () => {
  it("turns paragraphs into one list", () => {
    const editor = fromMd("aaa\n\nbbb");
    select(editor, "aaa", 0, "bbb", 3);
    press(editor);
    expect(toMd(editor)).toBe("* aaa\n* bbb\n");
  });

  it("turns a heading into a plain item", () => {
    const editor = fromMd("# aaa\n\nbbb");
    select(editor, "aaa", 0, "bbb", 3);
    press(editor, "numbered-list");
    expect(toMd(editor)).toBe("1. aaa\n2. bbb\n");
  });

  it("makes one item per soft line", () => {
    const editor = fromMd("l1\nl2\nl3");
    const line = "l1\nl2\nl3";
    select(editor, line, 0, line, 8);
    press(editor);
    expect(toMd(editor)).toBe("* l1\n* l2\n* l3\n");
  });

  it("nests a selected later paragraph under its item", () => {
    const editor = fromMd("- aaa\n\n  par\n- bbb");
    select(editor, "par", 0, "par", 3);
    press(editor);
    expect(view(editor.children)).toEqual(["b aaa", "  b par", "b bbb"]);
  });

  it("keeps a code block in its item", () => {
    const editor = fromMd("- aaa\n\n  ```\n  code\n  ```\n- bbb");
    select(editor, "aaa", 0, "bbb", 3);
    press(editor);
    expect(view(editor.children)).toEqual([
      "b aaa",
      "  code-block code",
      "b bbb",
    ]);
  });

  it("keeps a selected quote in its item", () => {
    const editor = fromMd("- aaa\n\n  > quo\n- bbb");
    select(editor, "aaa", 0, "bbb", 3);
    press(editor);
    expect(view(editor.children)).toEqual(["b aaa", "    b quo", "b bbb"]);
  });
});

describe("the action as a whole", () => {
  it("is one undo when the type changes", async () => {
    const editor = fromMd("- aaa\n  - kid\n- bbb");
    const start = JSON.stringify(view(editor.children));
    select(editor, "aaa", 1, "bbb", 2);
    await Promise.resolve();
    press(editor, "numbered-list");
    await Promise.resolve();
    HistoryEditor.undo(editor as HistoryEditor);
    await Promise.resolve();
    expect(JSON.stringify(view(editor.children))).toBe(start);
  });

  it("adds no undo step when nothing changes", async () => {
    const editor = fromMd("- aaa\n  - kid\n- bbb");
    select(editor, "aaa", 1, "bbb", 2);
    await Promise.resolve();
    const undos = editor.history.undos.length;
    press(editor);
    await Promise.resolve();
    expect(editor.history.undos.length).toBe(undos);
  });

  it("keeps the selection expanded on the same lines", () => {
    const editor = fromMd("- aaa\n  - kid\n- bbb");
    select(editor, "kid", 1, "bbb", 2);
    press(editor, "numbered-list");
    if (!editor.selection) throw new Error("no selection");
    expect(Editor.string(editor, editor.selection)).toBe("idbb");
  });
});
