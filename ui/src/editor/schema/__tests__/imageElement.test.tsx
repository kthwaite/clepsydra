import { render, screen } from "@testing-library/react";
import { createEditor, type Descendant } from "slate";
import { Editable, Slate, withReact } from "slate-react";
import { describe, expect, it } from "vitest";
import { renderElement } from "#/editor/elements/renderElement";
import { withSchema } from "../withSchema";

describe("image schema element", () => {
  it("renders an atomic CAS-backed image with its accessible metadata", () => {
    const editor = withReact(withSchema(createEditor()));
    const value: Descendant[] = [
      {
        type: "paragraph",
        children: [
          {
            type: "image",
            url: "cas:sha256:abc123",
            alt: "Archived chart",
            title: "Quarterly chart",
            children: [{ text: "" }],
          },
        ],
      },
    ];

    render(
      <Slate editor={editor} initialValue={value}>
        <Editable renderElement={renderElement} />
      </Slate>,
    );

    const image = screen.getByRole("img", { name: "Archived chart" });
    expect(image).toHaveAttribute("src", "/api/vault/cas/sha256:abc123");
    expect(image).toHaveAttribute("title", "Quarterly chart");
    expect(image.closest("[contenteditable=false]")).not.toBeNull();
  });
});
