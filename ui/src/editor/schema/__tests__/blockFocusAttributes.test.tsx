import { render } from "@testing-library/react";
import { createEditor, type Descendant } from "slate";
import { Editable, Slate, withReact } from "slate-react";
import { describe, expect, it } from "vitest";
import { renderElement } from "#/editor/elements/renderElement";
import { withSchema } from "../withSchema";

describe("block focus attributes", () => {
  it("marks every block-bearing editor element with its block ID", () => {
    const editor = withReact(withSchema(createEditor()));
    const value: Descendant[] = [
      {
        type: "paragraph",
        blockId: "paragraph1",
        children: [{ text: "Paragraph" }],
      },
      {
        type: "heading",
        level: 2,
        blockId: "heading123",
        children: [{ text: "Heading" }],
      },
      {
        type: "code-block",
        blockId: "codeblock1",
        children: [{ text: "const value = 1;" }],
      },
      {
        type: "blockquote",
        blockId: "quote12345",
        children: [{ type: "paragraph", children: [{ text: "Quote" }] }],
      },
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            blockId: "listitem01",
            children: [{ type: "paragraph", children: [{ text: "Item" }] }],
          },
        ],
      },
    ];

    const { container } = render(
      <Slate editor={editor} initialValue={value}>
        <Editable renderElement={renderElement} />
      </Slate>,
    );

    expect(
      Array.from(container.querySelectorAll("[data-block-id]"), (element) =>
        element.getAttribute("data-block-id"),
      ),
    ).toEqual([
      "paragraph1",
      "heading123",
      "codeblock1",
      "quote12345",
      "listitem01",
    ]);
  });
});
