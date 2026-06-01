import { fireEvent, render, screen } from "@testing-library/react";
import { createEditor, type Descendant } from "slate";
import {
  Editable,
  type RenderElementProps,
  Slate,
  withReact,
} from "slate-react";
import { describe, expect, it } from "vitest";
import { CodeBlockElement } from "#/editor/elements/CodeBlockElement";
import type { CodeBlockElement as CodeBlockElementType } from "#/editor/types";

function renderInEditor(language?: string) {
  const editor = withReact(createEditor());
  const value: Descendant[] = [
    {
      type: "code-block",
      ...(language ? { language } : {}),
      children: [{ text: "fn main() {}" }],
    } as any,
  ];
  const renderElement = (props: RenderElementProps) => (
    <CodeBlockElement
      {...props}
      element={props.element as CodeBlockElementType}
    />
  );
  render(
    <Slate editor={editor} initialValue={value}>
      <Editable renderElement={renderElement} />
    </Slate>,
  );
}

describe("CodeBlockElement", () => {
  it("shows the language label, uppercased", () => {
    renderInEditor("rust");
    expect(screen.getByRole("button", { name: "RUST" })).toBeDefined();
  });

  it("shows TXT when no language is set", () => {
    renderInEditor();
    expect(screen.getByRole("button", { name: "TXT" })).toBeDefined();
  });

  it("opens the picker when the label is clicked", () => {
    renderInEditor("rust");
    expect(screen.queryByPlaceholderText("Search language…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "RUST" }));
    expect(screen.getByPlaceholderText("Search language…")).toBeDefined();
  });
});
