import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { type Descendant, type Editor, Transforms } from "slate";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { editorRef } = vi.hoisted(() => ({
  editorRef: { current: null as Editor | null },
}));

vi.mock("slate-react", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const OriginalSlate = actual.Slate as ComponentType<
    { editor: Editor } & Record<string, unknown>
  >;
  return {
    ...actual,
    Slate: (props: { editor: Editor } & Record<string, unknown>) => {
      editorRef.current = props.editor;
      return <OriginalSlate {...props} />;
    },
  };
});

vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => vi.fn() }));

import { slateToMarkdown } from "#/editor/convert";
import { SlateEditor } from "#/editor/SlateEditor";

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get(this: HTMLElement) {
      return this.closest('[contenteditable="true"]') !== null;
    },
  });
});

beforeEach(() => {
  window.getSelection()?.removeAllRanges();
  editorRef.current = null;
});

function paragraph(children: Descendant[]): Descendant {
  return { type: "paragraph", children } as Descendant;
}

async function renderAt(
  initialValue: Descendant[],
  path: number[],
  offset: number,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SlateEditor
        initialValue={initialValue}
        onChange={vi.fn()}
        onSaveNow={vi.fn()}
      />
    </QueryClientProvider>,
  );
  const editor = editorRef.current;
  if (!editor) throw new Error("Slate editor is not active");
  const editable = screen.getByRole("textbox");
  await userEvent.setup().click(editable);
  act(() => Transforms.select(editor, { path, offset }));
  await waitFor(() =>
    expect(editor.selection?.anchor).toEqual({ path, offset }),
  );
  return { editable, editor };
}

const inlineMath = {
  type: "inline-math",
  tex: "x^2",
  delimiter: "$",
  children: [{ text: "" }],
} as Descendant;

describe("SlateEditor ←/→ into inline math", () => {
  it("ArrowLeft at the start of the text after inline math opens its source", async () => {
    const { editable } = await renderAt(
      [paragraph([{ text: "Before " }, inlineMath, { text: " after" }])],
      [0, 2],
      0,
    );

    fireEvent.keyDown(editable, { key: "ArrowLeft" });

    const source = await screen.findByRole("textbox", {
      name: "Edit inline math",
    });
    expect(source).toHaveValue("x^2");
    expect(source).toHaveFocus();
  });

  it("ArrowRight at the end of the text before inline math opens its source", async () => {
    const { editable } = await renderAt(
      [paragraph([{ text: "Before " }, inlineMath, { text: " after" }])],
      [0, 0],
      "Before ".length,
    );

    fireEvent.keyDown(editable, { key: "ArrowRight" });

    expect(
      await screen.findByRole("textbox", { name: "Edit inline math" }),
    ).toHaveValue("x^2");
  });

  it("exits back to the side it was entered from", async () => {
    const { editable, editor } = await renderAt(
      [paragraph([{ text: "Before " }, inlineMath, { text: " after" }])],
      [0, 2],
      0,
    );
    fireEvent.keyDown(editable, { key: "ArrowLeft" });
    const source = (await screen.findByRole("textbox", {
      name: "Edit inline math",
    })) as HTMLInputElement;

    source.setSelectionRange(3, 3);
    fireEvent.keyDown(source, { key: "ArrowRight" });

    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Edit inline math" }),
      ).toBeNull(),
    );
    expect(editor.selection?.anchor).toEqual({ path: [0, 2], offset: 0 });
  });

  it("does not open math when the caret is mid-text", async () => {
    const { editable } = await renderAt(
      [paragraph([{ text: "Before " }, inlineMath, { text: " after" }])],
      [0, 2],
      2,
    );

    fireEvent.keyDown(editable, { key: "ArrowLeft" });

    expect(
      screen.queryByRole("textbox", { name: "Edit inline math" }),
    ).toBeNull();
  });
});

const blockRef = {
  type: "block-ref",
  blockId: "abc123DEF0",
  children: [{ text: "" }],
} as Descendant;

describe("SlateEditor block-ref source editing", () => {
  async function enterBlockRef() {
    const harness = await renderAt(
      [paragraph([{ text: "See " }, blockRef, { text: " after" }])],
      [0, 2],
      0,
    );
    fireEvent.keyDown(harness.editable, { key: "ArrowLeft" });
    const input = (await screen.findByRole("textbox", {
      name: "Edit block reference",
    })) as HTMLInputElement;
    return { ...harness, input };
  }

  it("ArrowLeft opens the id between (( and )) with the caret at the end", async () => {
    const { input } = await enterBlockRef();

    expect(input).toHaveValue("abc123DEF0");
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe("abc123DEF0".length);
    const chrome = input.closest("[contenteditable='false']")?.parentElement;
    expect(chrome?.textContent).toContain("((");
    expect(chrome?.textContent).toContain("))");
  });

  it("commits a valid new id", async () => {
    const { editor, input } = await enterBlockRef();

    fireEvent.change(input, { target: { value: "zyx987WVU6" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(slateToMarkdown(editor.children)).toContain("((zyx987WVU6))"),
    );
  });

  it("marks an invalid id and ignores Enter", async () => {
    const { editor, input } = await enterBlockRef();

    fireEvent.change(input, { target: { value: "nope" } });
    expect(input).toHaveAttribute("aria-invalid", "true");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input).toBeInTheDocument();
    expect(slateToMarkdown(editor.children)).toContain("((abc123DEF0))");
  });

  it("Escape restores the node unchanged", async () => {
    const { editor, input } = await enterBlockRef();

    fireEvent.change(input, { target: { value: "zyx987WVU6" } });
    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Edit block reference" }),
      ).toBeNull(),
    );
    expect(slateToMarkdown(editor.children)).toContain("((abc123DEF0))");
    expect(editor.selection?.anchor).toEqual({ path: [0, 2], offset: 0 });
  });
});
