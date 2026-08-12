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
import { type Descendant, Editor, Transforms } from "slate";
import type { HistoryEditor } from "slate-history";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { slateToMarkdown } from "#/editor/convert";

// Slate detects native beforeinput support while its module loads. jsdom omits
// getTargetRanges, so provide the active DOM range before importing slate-react.
const { editorRef } = vi.hoisted(() => {
  Object.defineProperty(InputEvent.prototype, "getTargetRanges", {
    configurable: true,
    value: () => {
      const selection = window.getSelection();
      return selection?.rangeCount ? [selection.getRangeAt(0)] : [];
    },
  });
  return {
    editorRef: { current: null as Editor | null },
  };
});

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

async function renderTerminalInlineCode(withFollowingBlock = false) {
  const user = userEvent.setup();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  const initialValue: Descendant[] = [
    {
      type: "paragraph",
      children: [{ text: "code", code: true }],
    } as Descendant,
  ];
  if (withFollowingBlock) {
    initialValue.push({
      type: "paragraph",
      children: [{ text: "after" }],
    } as Descendant);
  }
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
  await user.click(editable);
  act(() => Transforms.select(editor, { path: [0, 0], offset: 4 }));
  await waitFor(() =>
    expect(editor.selection?.anchor).toEqual({ path: [0, 0], offset: 4 }),
  );

  return { editable, editor, user };
}

describe("SlateEditor terminal inline-code boundary", () => {
  it("exits inline code with ArrowRight before typing and undoes the insertion once", async () => {
    const { editable, editor, user } = await renderTerminalInlineCode();

    await user.keyboard("{ArrowRight}");
    await user.keyboard(" next");

    expect(slateToMarkdown(editor.children).trim()).toBe("`code` next");

    await waitFor(() => {
      const inlineCode = editable.querySelector("code");
      expect(inlineCode).toHaveTextContent("code");
      expect(inlineCode).not.toHaveTextContent("next");
      const plainText = Array.from(
        editable.querySelectorAll<HTMLElement>("[data-slate-string]"),
      ).find((node) => node.textContent === " next");
      expect(plainText).toBeDefined();
      expect(plainText?.closest("code")).toBeNull();
      expect(plainText?.closest(".font-mono")).toBeNull();
    });

    act(() => (editor as Editor & HistoryEditor).undo());

    await waitFor(() =>
      expect(slateToMarkdown(editor.children).trim()).toBe("`code`"),
    );
  });

  it("leaves a second ArrowRight available to navigate to a following block", async () => {
    const { editable, editor } = await renderTerminalInlineCode(true);

    expect(fireEvent.keyDown(editable, { key: "ArrowRight" })).toBe(false);
    expect(Editor.marks(editor)?.code).not.toBe(true);

    // jsdom does not synthesize native contenteditable caret movement. A true
    // return proves the second event remains available to the browser default.
    expect(fireEvent.keyDown(editable, { key: "ArrowRight" })).toBe(true);
  });

  it.each([
    ["native composition", { isComposing: true }],
    ["legacy IME composition", { keyCode: 229 }],
  ] as const)(
    "does not exit inline code during %s",
    async (_name, eventInit) => {
      const { editable, editor } = await renderTerminalInlineCode();

      expect(
        fireEvent.keyDown(editable, { key: "ArrowRight", ...eventInit }),
      ).toBe(true);
      expect(Editor.marks(editor)?.code).toBe(true);
      expect(slateToMarkdown(editor.children).trim()).toBe("`code`");
    },
  );
});
