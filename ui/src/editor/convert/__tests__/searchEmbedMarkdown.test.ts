import { createEditor, Editor } from "slate";
import { describe, expect, it } from "vitest";
import { withSchema } from "#/editor/schema/withSchema";
import { markdownToSlate, slateToMarkdown } from "../index";

describe("note-local search Markdown", () => {
  it("retains semantic query and default limit through normalization and repeated saves", () => {
    const source = "```search\nquery = 'kind:NOTE AND \"water clock\"'\n```\n";
    const editor = withSchema(createEditor());
    editor.children = markdownToSlate(source);
    Editor.normalize(editor, { force: true });
    expect(editor.children[0]).toMatchObject({
      type: "search-embed",
      status: "configured",
      query: 'kind:NOTE AND "water clock"',
    });
    expect(slateToMarkdown(editor.children)).toBe(source);
    expect(
      slateToMarkdown(markdownToSlate(slateToMarkdown(editor.children))),
    ).toBe(source);
  });

  it.each([
    '> ```search\n> query = "water"\n> ```\n',
    '> ```search\n> query = "water"\n> future = true\n> ```\n',
    '* ```search\n  query = "water"\n  ```\n',
  ])("keeps container-relative fence source across saves: %s", (source) => {
    const saved = slateToMarkdown(markdownToSlate(source));
    expect(saved).toBe(source);
    expect(slateToMarkdown(markdownToSlate(saved))).toBe(saved);
  });

  it.each([
    '~~~~search\r\n# future option\r\nquery = "clock"\r\nfuture = true\r\n~~~~',
    "```search\nquery = [\n```\n",
    '```search\nquery = " "\n```\n',
    '```search\nquery = "clock"\nlimit = 0\n```\n',
    '```search\nquery = "clock"\nlimit = 201\n```\n',
    '```search\nquery = "clock"\nlimit = 1.5\n```\n',
    '```search future\nquery = "clock"\n```\n',
  ])("preserves invalid or unknown source exactly: %s", (source) => {
    const value = markdownToSlate(source);
    expect(value[0]).toMatchObject({
      type: "search-embed",
      status: "invalid",
      rawBlock: source,
    });
    expect(slateToMarkdown(value)).toBe(source);
  });

  it.each([1, 200])("accepts the inclusive result limit %s", (limit) => {
    const value = markdownToSlate(
      `\`\`\`search\nquery = "clock"\nlimit = ${limit}\n\`\`\`\n`,
    );
    expect(value[0]).toMatchObject({
      type: "search-embed",
      status: "configured",
      limit,
    });
    expect(markdownToSlate(slateToMarkdown(value))[0]).toMatchObject({
      query: "clock",
      limit,
    });
  });
});
