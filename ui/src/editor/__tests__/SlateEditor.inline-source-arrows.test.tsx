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

describe("SlateEditor footnote-ref source editing", () => {
  it("ArrowRight opens the identifier between [^ and ] and commits a repoint", async () => {
    const { editable, editor } = await renderAt(
      [
        paragraph([
          { text: "Claim" },
          {
            type: "footnote-ref",
            identifier: "old",
            children: [{ text: "" }],
          } as Descendant,
          { text: "." },
        ]),
        {
          type: "footnote-def",
          identifier: "old",
          children: [{ text: "Old note" }],
        } as Descendant,
      ],
      [0, 0],
      "Claim".length,
    );

    fireEvent.keyDown(editable, { key: "ArrowRight" });
    const input = (await screen.findByRole("textbox", {
      name: "Edit footnote reference",
    })) as HTMLInputElement;
    expect(input).toHaveValue("old");
    expect(input.selectionStart).toBe(0);
    const chrome = input.closest("[contenteditable='false']")?.parentElement;
    expect(chrome?.textContent).toContain("[^");

    fireEvent.change(input, { target: { value: "new" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      const markdown = slateToMarkdown(editor.children);
      expect(markdown).toContain("Claim[^new].");
      expect(markdown).toContain("[^old]: Old note");
      expect(markdown).toMatch(/\[\^new\]:/);
    });
  });
});

const boldLink = {
  type: "link",
  url: "https://e.com",
  children: [{ text: "b", bold: true }, { text: " x" }],
} as Descendant;

describe("SlateEditor link source editing", () => {
  async function enterLink(
    value: Descendant[],
    path: number[],
    offset: number,
    key: "ArrowLeft" | "ArrowRight",
  ) {
    const harness = await renderAt(value, path, offset);
    fireEvent.keyDown(harness.editable, { key });
    const input = (await screen.findByRole("textbox", {
      name: "Edit link",
    })) as HTMLInputElement;
    return { ...harness, input };
  }

  it("ArrowRight at the end of the text before a link opens its Markdown", async () => {
    const { editor, input } = await enterLink(
      [paragraph([{ text: "See " }, boldLink, { text: " now." }])],
      [0, 0],
      "See ".length,
      "ArrowRight",
    );

    expect(input).toHaveValue("[**b** x](https://e.com)");
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    // The Slate selection stays in the text before the link.
    expect(editor.selection?.anchor).toEqual({ path: [0, 0], offset: 4 });
  });

  it("focuses the input only once Slate can map it to the link", async () => {
    // The session swaps the link's <a> root for a new <span>. Slate's onBlur
    // resolves the focus target to a Slate node; if the input takes focus
    // before the new root's ref is attached, that throws, the editor never
    // clears its focused flag, and it pulls focus back, cancelling the session.
    const harness = await renderAt(
      [paragraph([{ text: "See " }, boldLink, { text: " now." }])],
      [0, 0],
      "See ".length,
    );
    const { ReactEditor } =
      await vi.importActual<typeof import("slate-react")>("slate-react");
    const resolved: boolean[] = [];
    const onFocusIn = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLInputElement)) return;
      try {
        ReactEditor.toSlateNode(harness.editor, event.target);
        resolved.push(true);
      } catch {
        resolved.push(false);
      }
    };
    document.addEventListener("focusin", onFocusIn, true);
    try {
      fireEvent.keyDown(harness.editable, { key: "ArrowRight" });
      await screen.findByRole("textbox", { name: "Edit link" });
      await waitFor(() => expect(resolved).toEqual([true]));
    } finally {
      document.removeEventListener("focusin", onFocusIn, true);
    }
  });

  it("keeps the link's Slate children mounted but hidden during the session", async () => {
    const { input } = await enterLink(
      [paragraph([{ text: "See " }, boldLink, { text: " now." }])],
      [0, 0],
      "See ".length,
      "ArrowRight",
    );

    const element = input.closest("[data-slate-inline]");
    expect(element).not.toBeNull();
    const hidden = element?.querySelector(
      "[data-slate-node='text']",
    )?.parentElement;
    expect(hidden?.textContent).toBe("b x");
    expect(
      hidden?.closest("[hidden], [style*='display: none']"),
    ).not.toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("ArrowLeft at the start of the text after a link opens it with the caret at the end", async () => {
    const { input } = await enterLink(
      [paragraph([{ text: "See " }, boldLink, { text: " now." }])],
      [0, 2],
      0,
      "ArrowLeft",
    );

    expect(input.selectionStart).toBe("[**b** x](https://e.com)".length);
  });

  it("opens a link that is the first inline from the leading empty text", async () => {
    const { input } = await enterLink(
      [paragraph([{ text: "" }, boldLink, { text: " after" }])],
      [0, 0],
      0,
      "ArrowRight",
    );

    expect(input).toHaveValue("[**b** x](https://e.com)");
  });

  it("opens a link that is the last inline from the trailing empty text", async () => {
    const { input } = await enterLink(
      [paragraph([{ text: "See " }, boldLink, { text: "" }])],
      [0, 2],
      0,
      "ArrowLeft",
    );

    expect(input).toHaveValue("[**b** x](https://e.com)");
  });

  it("commits an edited url and exits after the new link", async () => {
    const { editor, input } = await enterLink(
      [paragraph([{ text: "See " }, boldLink, { text: " now." }])],
      [0, 0],
      "See ".length,
      "ArrowRight",
    );

    fireEvent.change(input, {
      target: { value: "[**b** x](https://other.org)" },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(slateToMarkdown(editor.children)).toBe(
        "See [**b** x](https://other.org) now.\n",
      ),
    );
    expect(editor.selection?.anchor).toEqual({ path: [0, 2], offset: 0 });
  });

  it("unlinks when the brackets are deleted", async () => {
    const { editor, input } = await enterLink(
      [paragraph([{ text: "See " }, boldLink, { text: " now." }])],
      [0, 2],
      0,
      "ArrowLeft",
    );

    fireEvent.change(input, { target: { value: "**b** x" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(slateToMarkdown(editor.children)).toBe("See **b** x now.\n"),
    );
  });

  it("an empty draft cancels and keeps the link", async () => {
    const { editor, input } = await enterLink(
      [paragraph([{ text: "See " }, boldLink, { text: " now." }])],
      [0, 0],
      "See ".length,
      "ArrowRight",
    );

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Edit link" })).toBeNull(),
    );
    expect(slateToMarkdown(editor.children)).toBe(
      "See [**b** x](https://e.com) now.\n",
    );
  });

  it("a plain click inside the label places the caret without a session", async () => {
    await renderAt(
      [paragraph([{ text: "See " }, boldLink, { text: " now." }])],
      [0, 0],
      0,
    );

    await userEvent.setup().click(screen.getByText("x", { exact: false }));

    expect(screen.queryByRole("textbox", { name: "Edit link" })).toBeNull();
  });
});
