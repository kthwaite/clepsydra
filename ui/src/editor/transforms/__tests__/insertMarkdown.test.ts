import { createEditor, Transforms } from "slate";
import { describe, expect, it } from "vitest";
import { withSchema } from "#/editor/schema/withSchema";
import { insertMarkdown } from "../insertMarkdown";

describe("insertMarkdown", () => {
  it("inserts an image at the current caret", () => {
    const editor = withSchema(createEditor());
    editor.children = [{ type: "paragraph", children: [{ text: "Before " }] }];
    Transforms.select(editor, { path: [0, 0], offset: 7 });

    insertMarkdown(
      editor,
      "![diagram.png](/api/vault/attachments/diagram.png)",
    );

    expect(editor.children).toEqual([
      {
        type: "paragraph",
        children: [
          { text: "Before " },
          {
            type: "image",
            url: "/api/vault/attachments/diagram.png",
            alt: "diagram.png",
            children: [{ text: "" }],
          },
          { text: "" },
        ],
      },
    ]);
  });

  it("appends Markdown when the editor has no selection", () => {
    const editor = withSchema(createEditor());
    editor.children = [{ type: "paragraph", children: [{ text: "Before" }] }];

    insertMarkdown(editor, "[paper.pdf](/api/vault/attachments/paper.pdf)");

    expect(editor.children).toHaveLength(2);
    expect(editor.children[1]).toMatchObject({
      type: "paragraph",
      children: [
        { text: "" },
        {
          type: "link",
          url: "/api/vault/attachments/paper.pdf",
          children: [{ text: "paper.pdf" }],
        },
        { text: "" },
      ],
    });
  });
});
