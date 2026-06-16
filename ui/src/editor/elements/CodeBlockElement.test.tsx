import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createEditor, type Descendant } from "slate";
import {
  Editable,
  type RenderElementProps,
  Slate,
  withReact,
} from "slate-react";
import { describe, expect, it, vi } from "vitest";
import { CodeBlockElement } from "#/editor/elements/CodeBlockElement";
import type { CodeBlockElement as CodeBlockElementType } from "#/editor/types";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

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
  return editor;
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

  it("selecting a language updates the code block's language", () => {
    const editor = renderInEditor("rust");
    fireEvent.click(screen.getByRole("button", { name: "RUST" }));
    const input = screen.getByPlaceholderText("Search language…");
    fireEvent.change(input, { target: { value: "python" } });
    fireEvent.mouseDown(screen.getByText("PYTHON"));
    expect((editor.children[0] as { language?: string }).language).toBe(
      "python",
    );
  });

  it("copies the code text when the copy button is pressed", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    renderInEditor("rust");

    await user.click(screen.getByRole("button", { name: "Copy code" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("fn main() {}"));
  });

  it("selecting Plain text clears the code block's language", () => {
    const editor = renderInEditor("rust");
    fireEvent.click(screen.getByRole("button", { name: "RUST" }));
    fireEvent.mouseDown(screen.getByText("Plain text"));
    expect(
      (editor.children[0] as { language?: string }).language,
    ).toBeUndefined();
  });
});
