import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createEditor, type Descendant, Transforms } from "slate";
import {
  Editable,
  type RenderElementProps,
  Slate,
  withReact,
} from "slate-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodeBlockElement } from "#/editor/elements/CodeBlockElement";
import type { CodeBlockElement as CodeBlockElementType } from "#/editor/types";

const { mermaidRenderMock } = vi.hoisted(() => ({
  mermaidRenderMock: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: mermaidRenderMock },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  mermaidRenderMock.mockReset();
  mermaidRenderMock.mockResolvedValue({ svg: "<svg></svg>" });
});

function renderInEditor(language?: string, readOnly = false, text?: string) {
  const editor = withReact(createEditor());
  const value: Descendant[] = [
    {
      type: "code-block",
      ...(language ? { language } : {}),
      children: [{ text: text ?? "fn main() {}" }],
    } as any,
  ];
  const renderElement = (props: RenderElementProps) => (
    <CodeBlockElement
      {...props}
      element={props.element as CodeBlockElementType}
    />
  );
  const { container } = render(
    <Slate editor={editor} initialValue={value}>
      <Editable renderElement={renderElement} readOnly={readOnly} />
    </Slate>,
  );
  return { editor, container };
}

const MERMAID_SOURCE = "graph TD;\n  a-->b;";

function renderMermaid(readOnly = false) {
  return renderInEditor("mermaid", readOnly, MERMAID_SOURCE);
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
    const { editor } = renderInEditor("rust");
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
    const { editor } = renderInEditor("rust");
    fireEvent.click(screen.getByRole("button", { name: "RUST" }));
    fireEvent.mouseDown(screen.getByText("Plain text"));
    expect(
      (editor.children[0] as { language?: string }).language,
    ).toBeUndefined();
  });

  it("shows no diagram toggle for a non-diagram language", () => {
    renderInEditor("rust");
    expect(screen.queryByRole("button", { name: "Show diagram" })).toBeNull();
  });

  it("renders a mermaid block as a diagram, with the source kept for a11y", async () => {
    const { container } = renderMermaid();

    await screen.findByTestId("mermaid-diagram");
    expect(mermaidRenderMock).toHaveBeenCalledWith(
      expect.any(String),
      MERMAID_SOURCE,
    );
    expect(container.querySelector("pre")).toHaveClass("sr-only");
  });

  it("toggles a mermaid block between diagram and source", async () => {
    const user = userEvent.setup();
    const { container } = renderMermaid();
    await screen.findByTestId("mermaid-diagram");

    const toggle = screen.getByRole("button", { name: "Show diagram" });
    await user.click(toggle);

    expect(screen.queryByTestId("mermaid-diagram")).toBeNull();
    expect(container.querySelector("pre")).not.toHaveClass("sr-only");

    await user.click(toggle);

    await screen.findByTestId("mermaid-diagram");
    expect(container.querySelector("pre")).toHaveClass("sr-only");
  });

  it("reveals the source while the caret is inside the block", async () => {
    const { editor, container } = renderMermaid();
    await screen.findByTestId("mermaid-diagram");

    // `useSelected` updates through a deferred selector, so the re-render
    // lands after the transform's own flush.
    await act(async () => {
      Transforms.select(editor, { path: [0, 0], offset: 0 });
    });

    expect(screen.queryByTestId("mermaid-diagram")).toBeNull();
    expect(container.querySelector("pre")).not.toHaveClass("sr-only");
  });

  it("clicking the diagram puts the caret in the source", async () => {
    const user = userEvent.setup();
    const { editor, container } = renderMermaid();
    await screen.findByTestId("mermaid-diagram");

    await user.click(
      screen.getByRole("button", { name: "Edit diagram source" }),
    );

    expect(editor.selection).not.toBeNull();
    expect(screen.queryByTestId("mermaid-diagram")).toBeNull();
    expect(container.querySelector("pre")).not.toHaveClass("sr-only");
  });

  it("renders the diagram again when toggled with the caret inside", async () => {
    const user = userEvent.setup();
    const { editor, container } = renderMermaid();
    await screen.findByTestId("mermaid-diagram");

    await act(async () => {
      Transforms.select(editor, { path: [0, 0], offset: 0 });
    });
    const toggle = screen.getByRole("button", { name: "Show diagram" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await user.click(toggle);

    await screen.findByTestId("mermaid-diagram");
    // The caret cannot stay in a source that is no longer on screen.
    expect(editor.selection).toBeNull();
    expect(container.querySelector("pre")).toHaveClass("sr-only");
  });

  it("offers no diagram activation in read-only mode", async () => {
    renderMermaid(true);
    await screen.findByTestId("mermaid-diagram");
    expect(
      screen.queryByRole("button", { name: "Edit diagram source" }),
    ).toBeNull();
  });

  it("keeps rendering the diagram for a selected block in read-only mode", async () => {
    const { editor, container } = renderMermaid(true);
    await screen.findByTestId("mermaid-diagram");

    await act(async () => {
      Transforms.select(editor, { path: [0, 0], offset: 0 });
    });

    expect(screen.getByTestId("mermaid-diagram")).toBeInTheDocument();
    expect(container.querySelector("pre")).toHaveClass("sr-only");
  });

  it("falls back to the source when mermaid cannot parse the block", async () => {
    mermaidRenderMock.mockRejectedValue(new Error("Parse error on line 1"));
    const { container } = renderMermaid();

    await waitFor(() =>
      expect(screen.getByTestId("mermaid-error")).toHaveTextContent(
        "Parse error on line 1",
      ),
    );
    expect(container.querySelector("pre")).not.toHaveClass("sr-only");
  });

  it("keeps copy available but makes language inert in read-only mode", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const { editor } = renderInEditor("rust", true);
    const before = JSON.parse(JSON.stringify(editor.children));

    expect(screen.getByText("RUST")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "RUST" })).toBeNull();
    expect(screen.queryByPlaceholderText("Search language…")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Copy code" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("fn main() {}"));
    expect(editor.children).toEqual(before);
  });
});
