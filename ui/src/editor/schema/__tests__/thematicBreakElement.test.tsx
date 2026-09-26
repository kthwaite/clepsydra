import { render, screen } from "@testing-library/react";
import { createEditor, type Descendant } from "slate";
import { Editable, Slate, withReact } from "slate-react";
import { describe, expect, it } from "vitest";
import { renderElement } from "#/editor/elements/renderElement";
import { withSchema } from "../withSchema";

describe("thematic break schema element", () => {
  it("keeps a separator for assistive tech but draws faint marks, not a rule", () => {
    const editor = withReact(withSchema(createEditor()));
    const value: Descendant[] = [
      { type: "paragraph", children: [{ text: "before" }] },
      { type: "thematic-break", children: [{ text: "" }] },
      { type: "paragraph", children: [{ text: "after" }] },
    ];

    render(
      <Slate editor={editor} initialValue={value}>
        <Editable renderElement={renderElement} />
      </Slate>,
    );

    const separator = screen.getByRole("separator");
    expect(separator).toHaveClass("sr-only");
    const block = separator.closest("[contenteditable=false]");
    expect(block).not.toBeNull();
    const marks = block?.querySelectorAll("[data-break-mark]") ?? [];
    expect(marks).toHaveLength(3);
    for (const mark of marks) {
      expect(mark).toHaveAttribute("aria-hidden", "true");
      expect(mark).toHaveClass("bg-faint");
    }
  });
});
