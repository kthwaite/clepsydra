import { createEditor, type Descendant, Editor, Transforms } from "slate";
import { describe, expect, it } from "vitest";
import { withSchema } from "../../schema/withSchema";
import { markdownToSlate, slateToMarkdown } from "../index";

const DUE = { due: "2026-11-04" };
const para = (text = "") => ({ type: "paragraph", children: [{ text }] });
const kids = (text = "kid") => ({
  type: "bulleted-list",
  children: [{ type: "list-item", children: [para(text)] }],
});
const bullets = (item: object) =>
  [{ type: "bulleted-list", children: [item] }] as unknown as Descendant[];
const emptyTask = (...rest: object[]) => ({
  type: "list-item",
  checked: true,
  properties: DUE,
  children: [para(), ...rest],
});

function load(md: string): Descendant[] {
  const editor = withSchema(createEditor());
  editor.children = markdownToSlate(md);
  Editor.normalize(editor, { force: true });
  return editor.children;
}
const reload = (doc: Descendant[]) => load(slateToMarkdown(doc));

type El = {
  type?: string;
  checked?: boolean;
  properties?: Record<string, string>;
  blockId?: string;
  children?: El[];
};
const firstItem = (doc: Descendant[]) => (doc[0] as El).children?.[0] as El;
const childTypes = (item: El) => item.children?.map((c) => c.type);

describe("an empty item whose metadata is its only text", () => {
  it("writes the checkbox straight after the marker", () => {
    expect(slateToMarkdown(bullets(emptyTask()))).toBe(
      "* [x] [due:: 2026-11-04]\n",
    );
  });

  it("keeps a kid under the task", () => {
    const back = reload(bullets(emptyTask(kids())));
    expect(back).toHaveLength(1);
    const item = firstItem(back);
    expect((back[0] as El).children).toHaveLength(1);
    expect(item.checked).toBe(true);
    expect(item.properties).toEqual(DUE);
    expect(childTypes(item)).toEqual(["paragraph", "bulleted-list"]);
  });

  it("keeps a heading in the task", () => {
    const heading = { type: "heading", level: 1, children: [{ text: "h" }] };
    const back = reload(bullets(emptyTask(heading)));
    expect(back).toHaveLength(1);
    expect(childTypes(firstItem(back))).toEqual(["paragraph", "heading"]);
  });

  it("keeps a code block and a kid in the task", () => {
    const code = { type: "code-block", children: [{ text: "c" }] };
    const back = reload(bullets(emptyTask(code, kids())));
    expect(childTypes(firstItem(back))).toEqual([
      "paragraph",
      "code-block",
      "bulleted-list",
    ]);
  });

  it("is stable across saves", () => {
    const once = slateToMarkdown(bullets(emptyTask(kids())));
    expect(slateToMarkdown(load(once))).toBe(once);
    expect(once).toBe("* [x] [due:: 2026-11-04]\n  * kid\n");
  });

  it("keeps a kid under a plain item with a property", () => {
    const doc = bullets({
      type: "list-item",
      properties: DUE,
      children: [para(), kids()],
    });
    const back = reload(doc);
    expect((back[0] as El).children).toHaveLength(1);
    expect(firstItem(back).properties).toEqual(DUE);
    expect(childTypes(firstItem(back))).toEqual(["paragraph", "bulleted-list"]);
  });

  it("keeps a kid under a numbered task", () => {
    const doc = [
      { type: "numbered-list", children: [emptyTask(kids())] },
    ] as unknown as Descendant[];
    expect(slateToMarkdown(doc)).toBe("1. [x] [due:: 2026-11-04]\n   * kid\n");
    const back = reload(doc);
    expect((back[0] as El).children).toHaveLength(1);
    expect(firstItem(back).checked).toBe(true);
    expect(childTypes(firstItem(back))).toEqual(["paragraph", "bulleted-list"]);
  });

  it("keeps two properties", () => {
    const doc = bullets({
      ...emptyTask(kids()),
      properties: { due: "2026-11-04", priority: "A" },
    });
    const item = firstItem(reload(doc));
    expect(item.properties).toEqual({ due: "2026-11-04", priority: "A" });
    expect(childTypes(item)).toEqual(["paragraph", "bulleted-list"]);
  });

  it("keeps a property and a block id", () => {
    const doc = bullets({ ...emptyTask(kids()), blockId: "abc123defg" });
    const item = firstItem(reload(doc));
    expect(item.properties).toEqual(DUE);
    expect(item.blockId).toBe("abc123defg");
    expect(childTypes(item)).toEqual(["paragraph", "bulleted-list"]);
  });
});

describe("the same task reached by deleting its text", () => {
  it("keeps the kid, checkbox and property after reload", () => {
    const editor = withSchema(createEditor());
    editor.children = markdownToSlate(
      "- [x] x [due:: 2026-11-04]\n  - kid\n- next",
    );
    Editor.normalize(editor, { force: true });
    const lead = [0, 0, 0];
    Transforms.select(editor, Editor.range(editor, lead));
    Transforms.delete(editor);
    const back = reload(editor.children);
    expect((back[0] as El).children).toHaveLength(2);
    const item = firstItem(back);
    expect(item.checked).toBe(true);
    expect(item.properties).toEqual(DUE);
    expect(childTypes(item)).toEqual(["paragraph", "bulleted-list"]);
  });
});

describe("items with text", () => {
  it("still keep the space before the metadata", () => {
    const doc = bullets({
      type: "list-item",
      checked: false,
      properties: DUE,
      children: [para("aaa"), kids()],
    });
    expect(slateToMarkdown(doc)).toBe(
      "* [ ] aaa [due:: 2026-11-04]\n  * kid\n",
    );
  });
});
