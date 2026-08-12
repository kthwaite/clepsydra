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
import {
  type Descendant,
  type Editor,
  Node,
  Range,
  Element as SlateElement,
  Transforms,
} from "slate";
import type { HistoryEditor } from "slate-history";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";

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

async function renderEditorWithSelectedB() {
  const user = userEvent.setup();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SlateEditor
        initialValue={[
          { type: "paragraph", children: [{ text: "abc" }] } as Descendant,
        ]}
        onChange={vi.fn()}
        onSaveNow={vi.fn()}
      />
    </QueryClientProvider>,
  );

  const editor = editorRef.current;
  if (!editor) throw new Error("Slate editor is not active");
  const editable = screen.getByRole("textbox");
  await user.click(editable);
  await act(async () => {
    Transforms.select(editor, {
      anchor: { path: [0, 0], offset: 1 },
      focus: { path: [0, 0], offset: 2 },
    });
  });
  await waitFor(() => expect(window.getSelection()?.toString()).toBe("b"));

  return { editor, user };
}

async function renderEditorWithInlineMath() {
  const user = userEvent.setup();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SlateEditor
        initialValue={[
          {
            type: "paragraph",
            children: [
              { text: "before" },
              {
                type: "inline-math",
                tex: "x^2",
                delimiter: "$",
                children: [{ text: "" }],
              },
              { text: "after" },
            ],
          } as Descendant,
        ]}
        onChange={vi.fn()}
        onSaveNow={vi.fn()}
      />
    </QueryClientProvider>,
  );

  const editor = editorRef.current;
  if (!editor) throw new Error("Slate editor is not active");
  const editable = screen.getByRole("textbox");
  await user.click(editable);
  return { editable, editor, user };
}

it("replaces a one-character selection once before continuing to type", async () => {
  const { editor, user } = await renderEditorWithSelectedB();

  await user.keyboard("xy");

  expect(Node.string(editor)).toBe("axyc");
  expect(Range.isCollapsed(editor.selection!)).toBe(true);
  expect(editor.selection?.anchor).toEqual({ path: [0, 0], offset: 3 });
});

it("replaces a one-character selection with punctuation once", async () => {
  const { editor, user } = await renderEditorWithSelectedB();

  await user.keyboard("!,");

  expect(Node.string(editor)).toBe("a!,c");
  expect(Range.isCollapsed(editor.selection!)).toBe(true);
  expect(editor.selection?.anchor).toEqual({ path: [0, 0], offset: 3 });
});

it("restores the selected character when undoing one replacement", async () => {
  const { editor, user } = await renderEditorWithSelectedB();

  await user.keyboard("x");
  expect(Node.string(editor)).toBe("axc");

  await act(async () => {
    (editor as Editor & HistoryEditor).undo();
  });

  expect(Node.string(editor)).toBe("abc");
});

it("opens source editing with Enter when an inline math void is selected", async () => {
  const { editable, editor } = await renderEditorWithInlineMath();
  act(() => Transforms.select(editor, [0, 1]));

  fireEvent.keyDown(editable, { key: "Enter" });

  expect(screen.getByRole("textbox", { name: "Edit inline math" })).toHaveValue(
    "x^2",
  );
});

it("leaves deletion of a selected math void to Slate", async () => {
  const { editor } = await renderEditorWithInlineMath();
  act(() => Transforms.select(editor, [0, 1]));

  act(() => editor.deleteBackward("character"));

  const paragraph = editor.children[0];
  if (!SlateElement.isElement(paragraph)) {
    throw new Error("Expected a paragraph");
  }
  expect(
    paragraph.children.some(
      (child) => SlateElement.isElement(child) && child.type === "inline-math",
    ),
  ).toBe(false);
});

it("leaves replacement of a selection spanning math to Slate", async () => {
  const { editor } = await renderEditorWithInlineMath();
  act(() =>
    Transforms.select(editor, {
      anchor: { path: [0, 0], offset: 6 },
      focus: { path: [0, 2], offset: 0 },
    }),
  );

  act(() => editor.insertText("z"));

  expect(Node.string(editor)).toBe("beforezafter");
  const paragraph = editor.children[0];
  if (!SlateElement.isElement(paragraph)) {
    throw new Error("Expected a paragraph");
  }
  expect(
    paragraph.children.some(
      (child) => SlateElement.isElement(child) && child.type === "inline-math",
    ),
  ).toBe(false);
});
