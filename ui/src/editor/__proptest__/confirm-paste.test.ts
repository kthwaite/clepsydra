/**
 * Deterministic reproductions of the paste and conversion findings in
 * FINDINGS-paste.md, written as the behaviour a user should see. Every test
 * here failed on unmodified dev. `view` prints one line per block: depth, kind
 * (b bullet, n number, p top-level paragraph, `!` an item whose first child is
 * a list), checkbox, text.
 */
import { type Descendant, Editor, Node, Transforms } from "slate";
import { HistoryEditor } from "slate-history";
import { describe, expect, it } from "vitest";
import { markdownToSlate, slateToMarkdown } from "../convert";
import { indentListItem } from "../plugins/withOutliner";
import { applySelectionList } from "../transforms/blockConversions";
import { strictShape } from "./census-paste";
import { makeEditor, outline, reload, tick } from "./harness";
import {
  applyPasteOp,
  pasteFragment,
  pasteMarkdown,
  slash,
} from "./harness-paste";

const view = (e: Editor) =>
  outline(e).map(
    (l) =>
      `${l.depth}${l.kind}${l.checked === null ? "" : l.checked ? "[x]" : "[ ]"}:${l.text}`,
  );
const fromMd = (md: string) => makeEditor(markdownToSlate(md));
const toMd = (e: Editor) => slateToMarkdown(e.children);
const reloaded = (e: Editor) => makeEditor(reload(e.children));

function pathOf(e: Editor, text: string) {
  const line = outline(e).find((l) => l.text === text);
  if (!line) throw new Error(`no line ${text} in ${view(e).join(" | ")}`);
  return line.path;
}

/** Caret `offset` characters into the line reading exactly `text`. */
function caret(e: Editor, text: string, offset = 0) {
  Transforms.select(e, { path: [...pathOf(e, text), 0], offset });
}

function range(e: Editor, a: string, ao: number, b: string, bo: number) {
  Transforms.select(e, {
    anchor: { path: [...pathOf(e, a), 0], offset: ao },
    focus: { path: [...pathOf(e, b), 0], offset: bo },
  });
}

/** Empties the line reading `text` and puts the caret in it. */
function emptyLine(e: Editor, text: string) {
  const p = pathOf(e, text);
  Transforms.delete(e, {
    at: { anchor: Editor.start(e, p), focus: Editor.end(e, p) },
  });
  Transforms.select(e, Editor.start(e, p));
}

function bubbleList(e: Editor, list: "bulleted-list" | "numbered-list") {
  Editor.withoutNormalizing(e, () => applySelectionList(e, list));
}

describe("paste of a Markdown list", () => {
  it("P1: at the end of a non-empty item adds sibling items", () => {
    const e = fromMd("- aaa\n- bbb");
    caret(e, "aaa", 3);
    pasteMarkdown(e, "- x\n- y\n- z");
    expect(strictShape(e)).toEqual([]);
    expect(view(e)).toEqual(["1b:aaax", "1b:y", "1b:z", "1b:bbb"]);
  });

  it("P1b: at the start of a non-empty item keeps one bullet per pasted item", () => {
    const e = fromMd("- aaa");
    caret(e, "aaa", 0);
    pasteMarkdown(e, "- x\n- y");
    expect(strictShape(e)).toEqual([]);
    expect(view(e)).toEqual(["1b:x", "1b:yaaa"]);
  });

  it("P2: into an empty item does not nest a second bullet", () => {
    const e = fromMd("- aaa\n- bbb");
    emptyLine(e, "bbb");
    pasteMarkdown(e, "- x\n- y");
    expect(strictShape(e)).toEqual([]);
    expect(view(e)).toEqual(["1b:aaa", "1b:x", "1b:y"]);
  });

  it("P2b: copying a nested item into an empty item gives one bullet", () => {
    const e = fromMd("- aaa\n  - kid\n- bbb");
    range(e, "kid", 0, "kid", 3);
    const fragment = e.getFragment();
    emptyLine(e, "bbb");
    pasteFragment(e, fragment);
    expect(toMd(e)).toBe("* aaa\n  * kid\n* kid\n");
  });

  it("P2c: replacing a selected item with a list stays at that depth", () => {
    const e = fromMd("- aaa\n- bbb");
    range(e, "bbb", 0, "bbb", 3);
    pasteMarkdown(e, "- x\n- y");
    expect(view(e)).toEqual(["1b:aaa", "1b:x", "1b:y"]);
  });

  it("P3: with an empty bullet does not throw", () => {
    const e = fromMd("- aaa");
    caret(e, "aaa", 3);
    expect(() => pasteMarkdown(e, "- x\n-")).not.toThrow();
    expect(strictShape(e)).toEqual([]);
    expect(view(e)).toEqual(["1b:aaax", "1b:"]);
  });

  it("P3b: of a lone empty bullet leaves a usable editor", () => {
    const e = fromMd("x");
    emptyLine(e, "x");
    expect(() => pasteMarkdown(e, "-")).not.toThrow();
    expect(e.selection).not.toBeNull();
  });

  it("P4: into a non-empty paragraph makes a real list, not stray items", () => {
    const e = fromMd("aaa\n\nzzz");
    caret(e, "aaa", 3);
    pasteMarkdown(e, "- x\n- y\n- z");
    expect(strictShape(e)).toEqual([]);
    expect(toMd(e)).toBe("aaax\n\n* y\n* z\n\nzzz\n");
  });

  it("P5: at a caret mid-text keeps the second item a bullet", () => {
    const e = fromMd("- aaa");
    caret(e, "aaa", 1);
    pasteMarkdown(e, "- x\n- y");
    expect(view(e)).toEqual(["1b:ax", "1b:yaa"]);
  });

  it("P5b: at a caret mid-text keeps a pasted kid nested", () => {
    const e = fromMd("- aaa");
    caret(e, "aaa", 1);
    pasteMarkdown(e, "- x\n  - y");
    expect(view(e)).toEqual(["1b:ax", "2b:yaa"]);
  });

  it("P18: a table at a caret in a non-empty item stays a table", () => {
    const e = fromMd("- aaa");
    caret(e, "aaa", 0);
    pasteMarkdown(e, "| a | b |\n| - | - |\n| c | d |");
    expect(strictShape(e)).toEqual([]);
    expect(outline(e).some((l) => l.kind === "table")).toBe(true);
  });

  it("P19: a divider pasted mid-text goes at the caret", () => {
    const e = fromMd("abc");
    caret(e, "abc", 1);
    pasteMarkdown(e, "---");
    expect(toMd(e)).toBe("a\n\n---\n\nbc\n");
  });
});

describe("paste: metadata, caret and history", () => {
  it("P16: pasted inline property text survives", () => {
    const e = fromMd("- aaa");
    caret(e, "aaa", 3);
    pasteMarkdown(e, "see [due:: 2026-11-04]");
    expect(toMd(e)).toContain("2026-11-04");
  });

  it("P16b: pasted text ending in a block-id shape survives", () => {
    const e = fromMd("aaa");
    caret(e, "aaa", 3);
    pasteMarkdown(e, "see ^abc123defg");
    expect(toMd(e)).toContain("abc123defg");
  });

  it("P17: typing continues after a paste that ends in a wikilink", async () => {
    const e = fromMd("aaa");
    caret(e, "aaa", 3);
    pasteMarkdown(e, "[[Foo]]");
    await tick();
    Editor.insertText(e, "Z");
    expect(toMd(e)).toBe("aaa[[Foo]]Z\n");
  });

  it("P22: one undo reverses one paste in a code block", async () => {
    const e = fromMd("```\nabc\n```");
    Transforms.select(e, { path: [0, 0], offset: 3 });
    e.history = { undos: [], redos: [] };
    await tick();
    Editor.insertText(e, "x");
    await tick();
    pasteMarkdown(e, "PASTE");
    await tick();
    HistoryEditor.undo(e as HistoryEditor);
    await tick();
    expect(Node.string(e.children[0])).toBe("abcx");
  });

  it("P23: a selection only touching a code block still parses Markdown", () => {
    const e = fromMd("- aaa\n\n  ```\n  code\n  ```\n- bbb");
    range(e, "aaa", 1, "bbb", 1);
    pasteMarkdown(e, "- x\n- y");
    expect(toMd(e)).not.toContain("\\-");
  });
});

describe("saved Markdown", () => {
  it("P6: a paragraph after a nested list stays out of the kid", () => {
    const e = fromMd("- a\n  - b\n\n  c");
    expect(view(e)).toEqual(["1b:a", "2b:b", "1paragraph:c"]);
    expect(view(reloaded(e))).toEqual(view(e));
  });

  it("P6b: a divider after an item's text stays a divider", () => {
    const e = fromMd("- a\n\n  ---");
    expect(view(reloaded(e))).toEqual(view(e));
    expect(strictShape(reloaded(e))).toEqual([]);
    expect(toMd(reloaded(e))).toContain("---");
  });

  it("P6c: a paragraph after a quote in an item stays out of the quote", () => {
    const e = fromMd("- a\n\n  > q\n\n  c");
    expect(view(reloaded(e))).toEqual(view(e));
  });

  it("P6d: reached by paste, the tail does not merge into the pasted kid", () => {
    const e = fromMd("- aaa");
    caret(e, "aaa", 1);
    pasteMarkdown(e, "- x\n  - y\n- z");
    expect(view(reloaded(e))).toEqual(view(e));
  });

  it("P7: an empty first kid survives save and reload", () => {
    const e = fromMd("- aaa");
    Transforms.select(e, Editor.end(e, []));
    Editor.insertBreak(e);
    indentListItem(e);
    expect(view(e)).toEqual(["1b:aaa", "2b:"]);
    expect(view(reloaded(e))).toEqual(["1b:aaa", "2b:"]);
  });

  it("P13: a task in an ordered list after another ordered list keeps its box", () => {
    const e = makeEditor([
      {
        type: "numbered-list",
        children: [
          {
            type: "list-item",
            children: [{ type: "paragraph", children: [{ text: "a" }] }],
          },
        ],
      },
      {
        type: "numbered-list",
        children: [
          {
            type: "list-item",
            checked: true,
            children: [{ type: "paragraph", children: [{ text: "b" }] }],
          },
        ],
      },
    ] as unknown as Descendant[]);
    expect(toMd(e)).toContain("[x] b");
  });

  it("P20: a task with a property and a second block keeps its text across saves", () => {
    const once = reload(
      markdownToSlate("- [ ] aaa [due:: 2026-11-04]\n\n  par"),
    );
    const twice = reload(once);
    expect(slateToMarkdown(twice)).toBe(
      "* [ ] aaa [due:: 2026-11-04]\n\n  par\n",
    );
  });

  it("P21: an assignee written with markup survives", () => {
    const e = fromMd("- [ ] aaa");
    caret(e, "aaa", 0);
    applyPasteOp(e, { k: "prop", key: "assignee", value: "a*b*" });
    const props = (
      reloaded(e).children[0] as unknown as {
        children: { properties?: unknown }[];
      }
    ).children[0].properties;
    expect(props).toEqual({ assignee: "a*b*" });
  });

  it("P21b: an assignee holding a bracket does not leak into the task text", () => {
    const e = fromMd("- [ ] aaa");
    caret(e, "aaa", 0);
    applyPasteOp(e, { k: "prop", key: "assignee", value: "a]b" });
    expect(view(reloaded(e))).toEqual(["1b[ ]:aaa"]);
  });

  it("P24: an emptied bold item does not become a divider", () => {
    const e = fromMd("- **ab**\n- c");
    range(e, "ab", 0, "ab", 2);
    Editor.deleteFragment(e);
    expect(toMd(e)).not.toContain("****");
    expect(
      reloaded(e).children.some(
        (n) => (n as { type?: string }).type === "thematic-break",
      ),
    ).toBe(false);
  });
});

describe("selection bubble list action", () => {
  it("P8: on a parent item leaves its kids under it", () => {
    const e = fromMd("- aaa\n  - kid\n- bbb");
    range(e, "aaa", 0, "aaa", 3);
    bubbleList(e, "bulleted-list");
    expect(strictShape(e)).toEqual([]);
    expect(view(e)).toEqual(["1b:aaa", "2b:kid", "1b:bbb"]);
  });

  it("P8b: on an item's first line leaves its other blocks in the item", () => {
    const e = fromMd("- aaa\n\n  par\n- bbb");
    range(e, "aaa", 0, "aaa", 3);
    bubbleList(e, "bulleted-list");
    expect(view(e)).toEqual(["1b:aaa", "1paragraph:par", "1b:bbb"]);
  });

  it("P9: across a parent and its kid adds no wrapper bullet", () => {
    const e = fromMd("- aaa\n  - kid\n- bbb");
    range(e, "aaa", 1, "kid", 2);
    bubbleList(e, "bulleted-list");
    expect(strictShape(e)).toEqual([]);
  });

  it("P9b: across a kid and a following parent adds no wrapper bullet", () => {
    const e = fromMd("- aaa\n  - kid\n- bbb");
    range(e, "kid", 1, "bbb", 2);
    bubbleList(e, "bulleted-list");
    expect(strictShape(e)).toEqual([]);
  });

  it("P10: keeps a task's checkbox", () => {
    const e = fromMd("- [x] aaa\n- [ ] bbb");
    range(e, "aaa", 0, "bbb", 3);
    bubbleList(e, "bulleted-list");
    expect(view(e)).toEqual(["1b[x]:aaa", "1b[ ]:bbb"]);
  });

  it("P10b: keeps a task's properties and block id", () => {
    const e = fromMd("- [ ] aaa [due:: 2026-11-04] ^abc123defg\n- bbb");
    range(e, "aaa", 0, "bbb", 3);
    bubbleList(e, "bulleted-list");
    expect(toMd(e)).toContain("[due:: 2026-11-04]");
    expect(toMd(e)).toContain("^abc123defg");
  });

  it("P11: a selection ending at the start of the next item leaves that item", () => {
    const e = fromMd("- aaa\n- bbb\n- ccc");
    range(e, "aaa", 0, "bbb", 0);
    bubbleList(e, "bulleted-list");
    expect(view(e)).toEqual(["1b:aaa", "1b:bbb", "1b:ccc"]);
  });

  it("P12: re-applying inside a numbered list keeps the numbering", () => {
    const e = fromMd("1. aaa\n2. bbb\n3. ccc");
    range(e, "bbb", 0, "bbb", 3);
    bubbleList(e, "numbered-list");
    expect(toMd(e)).toBe("1. aaa\n2. bbb\n3. ccc\n");
  });

  it("P12b: a line between two same-type lists joins them both", () => {
    const e = fromMd("1. aaa\n\nmid\n\n1) bbb");
    range(e, "mid", 0, "mid", 3);
    bubbleList(e, "numbered-list");
    expect(e.children).toHaveLength(1);
  });
});

describe("slash menu on a list item", () => {
  it("P12c: /bullet between two lists joins them both", () => {
    const e = fromMd("- aaa\n\nmid\n\n* bbb");
    caret(e, "mid", 0);
    slash(e, "bullet");
    expect(e.children).toHaveLength(1);
  });

  it("P14: /bullet on a bullet adds no second bullet", () => {
    const e = fromMd("- aaa\n- bbb");
    emptyLine(e, "aaa");
    slash(e, "bullet");
    expect(strictShape(e)).toEqual([]);
    expect(view(e)).toEqual(["1b:", "1b:bbb"]);
  });

  it("P14b: /task on a bullet makes that item a task", () => {
    const e = fromMd("- aaa\n  - kid");
    emptyLine(e, "aaa");
    slash(e, "task");
    expect(view(e)).toEqual(["1b[ ]:", "2b:kid"]);
  });

  it("P14c: /number on a bullet does not nest", () => {
    const e = fromMd("- top\n  - aaa\n  - bbb");
    emptyLine(e, "aaa");
    slash(e, "number");
    expect(strictShape(e)).toEqual([]);
  });

  it("P15: /h1 on a task keeps its checkbox and property after reload", () => {
    const e = fromMd("- [x] aaa [due:: 2026-11-04]");
    emptyLine(e, "aaa");
    slash(e, "h1");
    const back = reloaded(e);
    expect(outline(back)[0].checked).toBe(true);
    expect(toMd(back)).toBe(toMd(e));
  });

  it("P15b: /code on a task keeps its checkbox after reload", () => {
    const e = fromMd("- [x] aaa\n  - kid");
    emptyLine(e, "aaa");
    slash(e, "code");
    const item = reloaded(e).children[0] as unknown as {
      children: { checked?: boolean }[];
    };
    expect(item.children[0].checked).toBe(true);
  });
});
