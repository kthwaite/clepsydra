/**
 * Deterministic reproductions of autoformat findings A1 to A24,
 * written as the behaviour a typist should see. Every test here fails on
 * unmodified production code; a passing test means that finding was fixed.
 *
 *   bunx vitest run src/editor/__proptest__/confirm-autoformat.test.ts
 */
import { type Descendant, Editor, Node, Text, Transforms } from "slate";
import { HistoryEditor } from "slate-history";
import { describe, expect, it } from "vitest";
import { slateToMarkdown } from "../convert";
import { indentListItem } from "../plugins/withOutliner";
import {
  clone,
  makeEditor,
  outline,
  reload,
  shapeViolations,
  tick,
} from "./harness";

const p = (text: string, extra: Record<string, unknown> = {}): Descendant =>
  ({
    type: "paragraph",
    ...extra,
    children: [{ text }],
  }) as unknown as Descendant;
const li = (text: string, ...rest: Descendant[]): Descendant =>
  ({
    type: "list-item",
    children: [p(text), ...rest],
  }) as unknown as Descendant;
const task = (
  text: string,
  checked: boolean,
  ...rest: Descendant[]
): Descendant =>
  ({
    type: "list-item",
    checked,
    children: [p(text), ...rest],
  }) as unknown as Descendant;
const ul = (...items: Descendant[]): Descendant =>
  ({ type: "bulleted-list", children: items }) as unknown as Descendant;
const ol = (...items: Descendant[]): Descendant =>
  ({ type: "numbered-list", children: items }) as unknown as Descendant;

type Key = string | "ENTER" | "BS" | "UNDO" | "REDO" | "TAB";

/** Caret on outline line `line` at `at`, then keys one character at a time. */
async function play(
  doc: Descendant[],
  line: number,
  at: "start" | "end" | number,
  keys: Key[],
): Promise<Editor> {
  const e = makeEditor(doc);
  const l = outline(e)[line];
  if (at === "start") Transforms.select(e, Editor.start(e, l.path));
  else if (at === "end") Transforms.select(e, Editor.end(e, l.path));
  else {
    const s = Editor.start(e, l.path);
    Transforms.select(e, { path: s.path, offset: at });
  }
  e.history = { undos: [], redos: [] };
  await tick();
  for (const key of keys) {
    if (key === "ENTER") Editor.insertBreak(e);
    else if (key === "BS") Editor.deleteBackward(e, { unit: "character" });
    else if (key === "UNDO") HistoryEditor.undo(e as HistoryEditor);
    else if (key === "REDO") HistoryEditor.redo(e as HistoryEditor);
    else if (key === "TAB") indentListItem(e);
    else {
      for (const ch of key) {
        Editor.insertText(e, ch);
        await tick();
      }
    }
    await tick();
  }
  return e;
}

const view = (e: Editor) =>
  outline(e).map((l) => `${l.depth}${l.kind}:${l.text}`);
const saved = (e: Editor) => makeEditor(reload(e.children));
const toMd = (nodes: Descendant[]) => slateToMarkdown(clone(nodes));
const allText = (nodes: Descendant[]) =>
  nodes.map((n) => Node.string(n)).join("|");

function firstOfType<T>(nodes: Descendant[], type: string): T | null {
  for (const n of nodes) {
    if (Text.isText(n)) continue;
    const el = n as unknown as { type: string; children: Descendant[] };
    if (el.type === type) return n as unknown as T;
    const inner = firstOfType<T>(el.children, type);
    if (inner) return inner;
  }
  return null;
}

describe("A1: a literal [ at a block start is written as \\[ and reads back as display math", () => {
  it("keeps a child list under a parent whose text starts with [", async () => {
    const e = await play([ul(li("abc", ul(li("kid"))))], 0, "start", ["["]);
    expect(view(saved(e))).toEqual(["1b:[abc", "2b:kid"]);
  });

  it("keeps the list after a paragraph holding only [", async () => {
    const e = await play([p(""), ul(li("list"))], 0, "start", ["["]);
    expect(view(saved(e))).toEqual(["0p:[", "1b:list"]);
  });

  it("keeps [] as text, not an empty math block", async () => {
    const e = await play([p("")], 0, "start", ["[]"]);
    expect(saved(e).children).toEqual([p("[]")]);
  });
});

describe("A2: [ ] and [x] as typed never reach task promotion", () => {
  it("[ ] then Space in an item makes an unchecked task", async () => {
    const e = await play([ul(li("abc"))], 0, "start", ["[ ] "]);
    expect(view(e)).toEqual(["1b:abc"]);
    expect(outline(e)[0].checked).toBe(false);
  });

  it("[x] then Space in an item makes a checked task", async () => {
    const e = await play([ul(li("abc"))], 0, "start", ["[x] "]);
    expect(view(e)).toEqual(["1b:abc"]);
    expect(outline(e)[0].checked).toBe(true);
  });

  it("[ ] then Space in a paragraph makes a task list", async () => {
    const e = await play([p("")], 0, "start", ["[ ] done"]);
    expect(view(e)).toEqual(["1b:done"]);
    expect(outline(e)[0].checked).toBe(false);
  });
});

describe("A3: Enter on the only, empty paragraph of a blockquote", () => {
  it("does not throw when the quote is the last block", async () => {
    const e = await play([p("")], 0, "start", ["> ", "ENTER"]);
    expect(view(e)).toEqual(["0p:"]);
  });

  it("does not throw when a list precedes the quote", async () => {
    const e = await play([ul(li("before")), p("")], 1, "start", [
      "> ",
      "ENTER",
    ]);
    expect(view(e)).toEqual(["1b:before", "0p:"]);
  });

  it("leaves the new paragraph above the block that followed the quote", async () => {
    const e = await play([p(""), ul(li("after"))], 0, "start", ["> ", "ENTER"]);
    expect(view(e)).toEqual(["0p:", "1b:after"]);
  });
});

describe("A4: an empty leaf that keeps a mark serializes as a bare delimiter run", () => {
  it("**x** Enter does not write a thematic break on the next line", async () => {
    const e = await play([p("")], 0, "start", ["**x**", "ENTER"]);
    expect(firstOfType(saved(e).children, "thematic-break")).toBeNull();
  });

  it("**x** Backspace in an item keeps the item and the list whole", async () => {
    const e = await play([ul(li(""), li("next"))], 0, "start", ["**x**", "BS"]);
    expect(view(saved(e))).toEqual(["1b:", "1b:next"]);
  });

  it("`x` Backspace does not leave literal backticks", async () => {
    const e = await play([p("")], 0, "start", ["`x`", "BS"]);
    expect(allText(saved(e).children)).toBe("");
  });
});

describe("A5: undoing a transform restores a selection over the literal text", () => {
  it.each([
    ["**x**", "**x*"],
    ["[[x]]", "[[x]"],
    ["$x$", "$x"],
    ["[k:: v]", "[k:: v"],
  ])("%s then Undo then a key keeps what was typed", async (token, literal) => {
    const e = await play([ul(li("abcd "))], 0, "end", [token, "UNDO", "Z"]);
    expect(allText(e.children)).toBe(`abcd ${literal}Z`);
  });
});

describe("A6: typing a Markdown link character by character", () => {
  it("[y](u) gets the URL u", async () => {
    const e = await play([ul(li("see "))], 0, "end", ["[y](u)"]);
    const link = firstOfType<{ url: string }>(e.children, "link");
    expect(link?.url).toBe("u");
  });
});

describe("A7: the * bullet marker", () => {
  it("* then Space on an empty paragraph leaves an empty bullet", async () => {
    const e = await play([p("")], 0, "start", ["* "]);
    expect(view(e)).toEqual(["1b:"]);
  });

  it("* then Space before text does not add a stray asterisk", async () => {
    const e = await play([p("abc")], 0, "start", ["* "]);
    expect(view(e)).toEqual(["1b:abc"]);
  });
});

describe("A8: display math typed in a list item", () => {
  it.each(["$$x$$", "\\[x\\]"])(
    "%s keeps paragraph first in the item",
    async (token) => {
      const e = await play([ul(li("a"), li(""))], 1, "start", [token]);
      expect(shapeViolations(e)).toEqual([]);
    },
  );
});

describe("A9: display math inside a list item across saves", () => {
  it("does not grow its source on each save", async () => {
    const e = await play([ul(li("lead", p("")))], 1, "start", ["$$x$$"]);
    const once = reload(e.children);
    const twice = reload(once);
    expect(toMd(twice)).toBe(toMd(once));
    expect(firstOfType<{ tex: string }>(twice, "math-block")?.tex.trim()).toBe(
      "x",
    );
    expect(firstOfType<{ tex: string }>(once, "math-block")?.tex).toBe(
      firstOfType<{ tex: string }>(twice, "math-block")?.tex,
    );
  });
});

describe("A10: --- typed in a list item", () => {
  it("keeps paragraph first in the item", async () => {
    const e = await play([ul(li("a"), li(""))], 1, "start", ["---"]);
    expect(shapeViolations(e)).toEqual([]);
  });

  it("does not drop the task state on reload", async () => {
    const e = await play([ul(task("", false))], 0, "start", ["---"]);
    expect(outline(saved(e))[0].checked).toBe(false);
  });

  it("does not strand the caret where typing is discarded", async () => {
    const e = await play([ul(li(""))], 0, "start", ["---", "BS", "Z"]);
    expect(allText(e.children)).toContain("Z");
  });
});

describe("A11: literal text in metadata syntax disappears on reload", () => {
  it("a typed ^word stays visible", async () => {
    const e = await play([ul(li("see"))], 0, "end", [" ^superscripts"]);
    expect(allText(saved(e).children)).toBe("see ^superscripts");
  });

  it("a [k:: v] the editor left literal stays visible", async () => {
    const e = await play([ul(li(""))], 0, "start", ["$5 [k:: v]"]);
    expect(allText(e.children)).toBe("$5 [k:: v]");
    expect(allText(saved(e).children)).toBe("$5 [k:: v]");
  });

  it("a typed ((id)) stays visible", async () => {
    const e = await play([ul(li("a "))], 0, "end", ["((abcdefghij))"]);
    expect(allText(e.children)).toBe("a ((abcdefghij))");
    expect(allText(saved(e).children)).toBe("a ((abcdefghij))");
  });
});

describe("A12: item metadata when the item has more than one block, or no text", () => {
  it("a property does not grow the line by a space per save", async () => {
    const e = await play([ul(li("lead", p("more")))], 0, "end", [" [k:: v]"]);
    const once = reload(e.children);
    const twice = reload(once);
    expect(toMd(twice)).toBe(toMd(once));
  });

  it("a block id survives a second save", async () => {
    const e = await play([ul(li("lead", p("more")))], 1, "end", [
      " ^abcdefghij",
    ]);
    const twice = reload(reload(e.children));
    expect(firstOfType<{ blockId?: string }>(twice, "list-item")?.blockId).toBe(
      "abcdefghij",
    );
    expect(allText(twice)).toBe("leadmore");
  });

  it("an emptied item's block id does not become visible text", async () => {
    const start = ul({
      type: "list-item",
      blockId: "qqqqqqqqqq",
      children: [p("a")],
    } as unknown as Descendant);
    const e = await play([start], 0, "end", ["BS"]);
    expect(allText(saved(e).children)).toBe("");
  });
});

describe("A13: a metadata suffix defeats block-start escaping", () => {
  it.each([
    ["- [k:: v]", "1b:-"],
    ["1. [k:: v]", "1b:1."],
  ])("%s stays one item on reload", async (keys, line) => {
    const e = await play([ul(li(""))], 0, "start", [keys]);
    expect(view(saved(e))).toEqual([line]);
  });
});

describe("A14: an empty nested first item", () => {
  it("Enter then Tab then save does not write * into the parent's text", async () => {
    const e = await play([ul(li("a"))], 0, "end", ["ENTER", "TAB"]);
    expect(view(e)).toEqual(["1b:a", "2b:"]);
    expect(view(saved(e))).toEqual(["1b:a", "2b:"]);
  });
});

describe("A15: a mark that cannot flank in CommonMark", () => {
  it("~a!~ directly before a word stays struck on reload", async () => {
    const e = await play([ul(li("bcd"))], 0, "start", ["~a!~"]);
    expect(allText(e.children)).toBe("a!bcd");
    expect(allText(saved(e).children)).toBe("a!bcd");
  });

  it("*a!* directly before **b** stays italic on reload", async () => {
    const e = await play([ul(li("cd"))], 0, "start", ["*a!*", "**b**"]);
    expect(allText(e.children)).toBe("a!bcd");
    expect(allText(saved(e).children)).toBe("a!bcd");
  });

  it("a space typed after ~x~ does not expose the tildes", async () => {
    const e = await play([p("")], 0, "start", ["~x~ "]);
    expect(allText(saved(e).children).trim()).toBe("x");
  });
});

describe("A16: a list marker merges with the previous list only", () => {
  it("- between two bulleted lists leaves one list", async () => {
    const e = await play(
      [ul(li("one")), p("para"), ul(li("two"))],
      1,
      "start",
      ["- "],
    );
    expect(e.children).toHaveLength(1);
    expect(view(e)).toEqual(["1b:one", "1b:para", "1b:two"]);
  });

  it("1. before a numbered task list keeps the checkbox on reload", async () => {
    const e = await play([p("para"), ol(task("job", false))], 0, "start", [
      "1. ",
    ]);
    const job = outline(saved(e)).find((l) => l.text === "job");
    expect(job?.checked).toBe(false);
  });
});

describe("A17: a list marker on a paragraph that carries metadata", () => {
  it("moves the property onto the item, where the chips and the loader read it", async () => {
    const e = await play(
      [p("abcd", { properties: { pk: "pv" } })],
      0,
      "start",
      ["- "],
    );
    const item = firstOfType<{ properties?: Record<string, string> }>(
      e.children,
      "list-item",
    );
    expect(item?.properties).toEqual({ pk: "pv" });
  });
});

describe("A18: a property typed mid-text", () => {
  it("does not join the words either side of it", async () => {
    const e = await play([ul(li("ab cde"))], 0, 3, ["[k:: v]"]);
    expect(allText(e.children)).toBe("ab cde");
  });
});

describe("A19: Enter in a paragraph that carries metadata", () => {
  it("does not copy the block id to both halves", async () => {
    const e = await play([p("abcd", { blockId: "qqqqqqqqqq" })], 0, 2, [
      "ENTER",
    ]);
    const ids = e.children.filter(
      (n) => (n as { blockId?: string }).blockId === "qqqqqqqqqq",
    );
    expect(ids).toHaveLength(1);
  });
});

describe("A20: Enter on an empty item that carries a typed property", () => {
  it("keeps the property", async () => {
    const e = await play([ul(li(""), li("b"))], 0, "start", [
      "[k:: v]",
      "ENTER",
    ]);
    expect(toMd(e.children)).toContain("[k:: v]");
  });
});

describe("A21: Undo of display math in a one-block document", () => {
  it("leaves a caret, so the next key is not dropped", async () => {
    const e = await play([p("")], 0, "start", ["$$x$$", "UNDO"]);
    expect(e.selection).not.toBeNull();
  });
});

describe("A22: Redo of an auto-pair", () => {
  it("restores the caret between the pair", async () => {
    const e = await play([p("")], 0, "start", ["*", "UNDO", "REDO", "x"]);
    expect(allText(e.children)).toBe("*x*");
  });
});

describe("A23: two adjacent inline maths", () => {
  it("stay two across a reload", async () => {
    const e = await play([ul(li(""))], 0, "start", ["$x$$y$"]);
    const math = (n: Descendant[]) => {
      const out: string[] = [];
      const walk = (d: Descendant) => {
        if (Text.isText(d)) return;
        const el = d as unknown as {
          type: string;
          tex?: string;
          children: Descendant[];
        };
        if (el.type === "inline-math") out.push(el.tex ?? "");
        el.children.forEach(walk);
      };
      n.forEach(walk);
      return out;
    };
    expect(math(e.children)).toEqual(["x", "y"]);
    expect(math(saved(e).children)).toEqual(["x", "y"]);
  });
});

describe("A24: an empty blockquote on reload", () => {
  it("keeps its paragraph, so block rules still apply", async () => {
    const e = await play([p("")], 0, "start", ["> "]);
    const quote = saved(e).children[0] as unknown as {
      children: { type?: string }[];
    };
    expect(quote.children[0].type).toBe("paragraph");
  });
});
