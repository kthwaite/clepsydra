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
  Editor,
  Node,
  Path,
  Element as SlateElement,
  Transforms,
} from "slate";
import { ReactEditor } from "slate-react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const harnessState = vi.hoisted(() => {
  Object.defineProperty(InputEvent.prototype, "getTargetRanges", {
    configurable: true,
    value: () => {
      const selection = window.getSelection();
      return selection?.rangeCount ? [selection.getRangeAt(0)] : [];
    },
  });
  return {
    editor: null as Editor | null,
    tableFocusAvailable: true,
    tablePreventsEscape: false,
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
      harnessState.editor = props.editor;
      return <OriginalSlate {...props} />;
    },
  };
});

vi.mock("#/components/bases/BaseEmbedInspector", () => ({
  BaseEmbedInspector: ({
    isOpen,
    node,
    onSave,
    onCancel,
    onRestoreFocus,
  }: {
    isOpen: boolean;
    node: { status: string };
    onSave(node: Descendant): void;
    onCancel(): void;
    onRestoreFocus(): void;
  }) =>
    isOpen ? (
      <div role="dialog" aria-label="Configure Base embed">
        <span>{node.status}</span>
        <button
          type="button"
          onClick={() => {
            onSave({
              type: "base-embed",
              status: "configured",
              base: "reading",
              view: "All",
              children: [{ text: "" }],
            } as Descendant);
            onRestoreFocus();
          }}
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            onCancel();
            onRestoreFocus();
          }}
        >
          Cancel
        </button>
      </div>
    ) : null,
}));

vi.mock("#/editor/elements/EmbeddedBaseTable", async () => {
  const React = await import("react");
  return {
    EmbeddedBaseTable: React.forwardRef(function MockEmbeddedBaseTable(
      _props: Record<string, unknown>,
      ref: React.ForwardedRef<{ focusEntry(): boolean }>,
    ) {
      const entryRef = React.useRef<HTMLButtonElement>(null);
      React.useImperativeHandle(ref, () => ({
        focusEntry() {
          if (
            !harnessState.tableFocusAvailable ||
            !entryRef.current?.isConnected
          ) {
            return false;
          }
          entryRef.current.focus();
          return document.activeElement === entryRef.current;
        },
      }));
      return (
        <button
          ref={entryRef}
          type="button"
          onKeyDown={(event) => {
            if (event.key === "Escape" && harnessState.tablePreventsEscape) {
              event.preventDefault();
            }
          }}
        >
          Table entry
        </button>
      );
    }),
  };
});

import { markdownToSlate, slateToMarkdown } from "#/editor/convert";
import { SlateEditor } from "#/editor/SlateEditor";
import type { BaseEmbedElement } from "#/editor/types";

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get(this: HTMLElement) {
      return this.closest('[contenteditable="true"]') !== null;
    },
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => Object.assign([], { item: () => null }),
  });
});

beforeEach(() => {
  window.getSelection()?.removeAllRanges();
  harnessState.editor = null;
  harnessState.tableFocusAvailable = true;
  harnessState.tablePreventsEscape = false;
});

const paragraph = (text: string): Descendant =>
  ({
    type: "paragraph",
    children: [{ text }],
  }) as Descendant;

const configured = (overrides: Partial<BaseEmbedElement> = {}): Descendant =>
  ({
    type: "base-embed",
    status: "configured",
    base: "reading",
    view: "All",
    filter: { field: "rating", op: "gte", value: 4 },
    sort: [
      { field: "rating", dir: "desc" },
      { field: "title", dir: "asc" },
    ],
    limit: 20,
    children: [{ text: "" }],
    ...overrides,
  }) as Descendant;

const invalid = (): Descendant =>
  ({
    type: "base-embed",
    status: "invalid",
    rawBlock: "```base\nnot toml\n```\n",
    parseError: "Invalid TOML",
    children: [{ text: "" }],
  }) as Descendant;

function renderEditor(initialValue: Descendant[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  const onChange = vi.fn();
  const onSaveNow = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <SlateEditor
        initialValue={initialValue}
        onChange={onChange}
        onSaveNow={onSaveNow}
      />
    </QueryClientProvider>,
  );
  const editor = harnessState.editor;
  if (!editor) throw new Error("Slate editor was not mounted");
  return {
    ...view,
    client,
    editor,
    editable: screen.getByRole("textbox"),
    onChange,
    onSaveNow,
  };
}

async function insertBaseFromSlash() {
  const user = userEvent.setup();
  const harness = renderEditor([paragraph("before"), paragraph("")]);
  await user.click(harness.editable);
  act(() => Transforms.select(harness.editor, { path: [1, 0], offset: 0 }));
  await user.type(harness.editable, "/base");
  const option = await screen.findByRole("option", { name: /Base embed/i });
  fireEvent.mouseDown(option);
  await screen.findByRole("dialog", { name: "Configure Base embed" });
  const embeds = Array.from(
    Editor.nodes(harness.editor, {
      at: [],
      match: (node) =>
        SlateElement.isElement(node) && node.type === "base-embed",
      voids: true,
    }),
  );
  return { ...harness, embeds, user };
}

function selectBase(editor: Editor, path: Path) {
  act(() => {
    Transforms.select(editor, path);
  });
}

async function focusSlate(editor: Editor, editable: HTMLElement) {
  act(() => editable.focus());
  fireEvent.focus(editable);
  await waitFor(() => expect(ReactEditor.isFocused(editor)).toBe(true));
  expect(document.activeElement).toBe(editable);
}

describe("Base slash command and editing session", () => {
  it("discovers Base embed and inserts exactly one selected unconfigured void", async () => {
    const { editor, embeds } = await insertBaseFromSlash();
    expect(embeds).toHaveLength(1);
    expect(embeds[0][0]).toMatchObject({
      type: "base-embed",
      status: "unconfigured",
      children: [{ text: "" }],
    });
    expect(editor.selection?.anchor.path.slice(0, 1)).toEqual(embeds[0][1]);
    expect(
      screen.getByRole("dialog", { name: "Configure Base embed" }),
    ).toBeVisible();
  });

  it("Save replaces only the original insertion identity once after paths shift", async () => {
    const { editor, embeds, user } = await insertBaseFromSlash();
    const original = embeds[0][0];
    const originalPath = embeds[0][1];
    const decoy = {
      type: "base-embed",
      status: "unconfigured",
      children: [{ text: "" }],
    } as Descendant;
    act(() => Transforms.insertNodes(editor, decoy, { at: originalPath }));

    await user.click(screen.getByRole("button", { name: "Save" }));

    const nodes = Array.from(
      Editor.nodes(editor, {
        at: [],
        match: (node) =>
          SlateElement.isElement(node) && node.type === "base-embed",
        voids: true,
      }),
    );
    expect(nodes).toHaveLength(2);
    expect(nodes.filter(([node]) => node === decoy)).toHaveLength(1);
    expect(nodes.filter(([node]) => node === original)).toHaveLength(0);
    expect(
      nodes.filter(
        ([node]) => (node as BaseEmbedElement).status === "configured",
      ),
    ).toHaveLength(1);
  });

  it("Cancel removes the exact insertion and restores its pre-insertion bookmark", async () => {
    const { editor, embeds, user } = await insertBaseFromSlash();
    const original = embeds[0][0];
    const originalPath = embeds[0][1];
    const decoy = {
      type: "base-embed",
      status: "unconfigured",
      children: [{ text: "" }],
    } as Descendant;
    act(() => Transforms.insertNodes(editor, decoy, { at: originalPath }));

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    const nodes = Array.from(
      Editor.nodes(editor, {
        at: [],
        match: (node) =>
          SlateElement.isElement(node) && node.type === "base-embed",
        voids: true,
      }),
    );
    expect(nodes.map(([node]) => node)).toEqual([decoy]);
    expect(nodes.some(([node]) => node === original)).toBe(false);
    expect(Node.string(editor.children[editor.selection!.anchor.path[0]])).toBe(
      "",
    );
  });

  it("emergency serializes an open insertion and reloads it as recoverable invalid source", async () => {
    const { editor } = await insertBaseFromSlash();
    const markdown = slateToMarkdown(editor.children);
    expect(markdown).toContain("```base\n```\n");
    expect(markdownToSlate(markdown)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "base-embed",
          status: "invalid",
          rawBlock: "```base\n```\n",
        }),
      ]),
    );
  });

  it.each([
    ["configured", configured()],
    ["invalid", invalid()],
  ])(
    "cancels %s editing without changing the node and restores Edit embed",
    async (_name, node) => {
      const user = userEvent.setup();
      const { editor } = renderEditor([
        paragraph("before"),
        node,
        paragraph("after"),
      ]);
      const original = editor.children[1];
      await user.click(screen.getByRole("button", { name: "Edit embed" }));
      expect(
        screen.getByRole("dialog", { name: "Configure Base embed" }),
      ).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(editor.children[1]).toBe(original);
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Edit embed" }),
        ).toHaveFocus(),
      );
    },
  );

  it("closes the editing lifecycle when the exact node is removed while open", async () => {
    const user = userEvent.setup();
    const { editor } = renderEditor([
      paragraph("before"),
      configured(),
      paragraph("after"),
    ]);
    await user.click(screen.getByRole("button", { name: "Edit embed" }));
    expect(
      screen.getByRole("dialog", { name: "Configure Base embed" }),
    ).toBeVisible();
    act(() => Transforms.removeNodes(editor, { at: [1], voids: true }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Configure Base embed" }),
      ).toBeNull(),
    );
  });
});

describe("Base embed keyboard ownership", () => {
  it.each(["Enter", "F2"])(
    "%s enters the active table control before editor actions",
    async (key) => {
      const { editor, editable } = renderEditor([
        configured(),
        paragraph("after"),
      ]);
      selectBase(editor, [0]);
      await focusSlate(editor, editable);
      fireEvent.keyDown(editable, { key });
      expect(screen.getByRole("button", { name: "Table entry" })).toHaveFocus();
    },
  );

  it("falls back from the table to Edit embed, then Remove", async () => {
    harnessState.tableFocusAvailable = false;
    const { editor, editable } = renderEditor([
      configured(),
      paragraph("after"),
    ]);
    selectBase(editor, [0]);
    await focusSlate(editor, editable);
    fireEvent.keyDown(editable, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Edit embed" })).toHaveFocus();

    const edit = screen.getByRole("button", { name: "Edit embed" });
    edit.remove();
    await focusSlate(editor, editable);
    fireEvent.keyDown(editable, { key: "F2" });
    expect(
      screen.getByRole("button", { name: "Remove Base embed" }),
    ).toHaveFocus();
  });

  it("before Shift+Tab exits before, with the first-block guard falling back after", async () => {
    const normal = renderEditor([
      paragraph("before"),
      configured(),
      paragraph("after"),
    ]);
    fireEvent.keyDown(screen.getByTestId("base-embed-before-guard"), {
      key: "Tab",
      shiftKey: true,
    });
    await waitFor(() =>
      expect(normal.editor.selection?.anchor.path[0]).toBe(0),
    );
    normal.unmount();

    const first = renderEditor([configured(), paragraph("after")]);
    fireEvent.keyDown(screen.getByTestId("base-embed-before-guard"), {
      key: "Tab",
      shiftKey: true,
    });
    await waitFor(() => expect(first.editor.selection?.anchor.path[0]).toBe(1));
  });

  it("after Tab exits to the point following the block", async () => {
    const { editor } = renderEditor([
      paragraph("before"),
      configured(),
      paragraph("after"),
    ]);
    fireEvent.keyDown(screen.getByTestId("base-embed-after-guard"), {
      key: "Tab",
    });
    await waitFor(() => expect(editor.selection?.anchor.path[0]).toBe(2));
  });

  it("unhandled descendant Escape exits after, while prevented Escape stays owned", async () => {
    const first = renderEditor([configured(), paragraph("after")]);
    const table = screen.getByRole("button", { name: "Table entry" });
    table.focus();
    fireEvent.keyDown(table, { key: "Escape" });
    await waitFor(() => expect(first.editor.selection?.anchor.path[0]).toBe(1));
    first.unmount();

    harnessState.tablePreventsEscape = true;
    const second = renderEditor([configured(), paragraph("after")]);
    const protectedTable = screen.getByRole("button", { name: "Table entry" });
    protectedTable.focus();
    fireEvent.keyDown(protectedTable, { key: "Escape" });
    expect(protectedTable).toHaveFocus();
    expect(second.editor.selection).toBeNull();
  });

  it("deletes a selected embed only while Slate owns focus", async () => {
    const { editor, editable } = renderEditor([
      paragraph("before"),
      configured(),
      paragraph("after"),
    ]);
    selectBase(editor, [1]);
    const edit = screen.getByRole("button", { name: "Edit embed" });
    edit.focus();
    const focused = vi
      .spyOn(ReactEditor, "isFocused")
      .mockReturnValueOnce(false);
    fireEvent.keyDown(edit, { key: "Delete" });
    focused.mockRestore();
    expect((editor.children[1] as BaseEmbedElement).type).toBe("base-embed");

    await focusSlate(editor, editable);
    fireEvent.keyDown(editable, { key: "Delete" });
    expect(
      editor.children.some(
        (node) => SlateElement.isElement(node) && node.type === "base-embed",
      ),
    ).toBe(false);
    expect(editor.selection?.anchor.path[0]).toBe(1);
  });

  it("Remove focuses the following point and falls back to the preceding point", async () => {
    const first = renderEditor([
      paragraph("before"),
      configured(),
      paragraph("after"),
    ]);
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Base embed" }),
    );
    await waitFor(() => expect(first.editor.selection?.anchor.path[0]).toBe(1));
    first.unmount();

    const second = renderEditor([paragraph("before"), configured()]);
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Base embed" }),
    );
    await waitFor(() =>
      expect(second.editor.selection?.anchor.path[0]).toBe(0),
    );
  });

  it("preserves descendant focus and Slate selection through autosave and parent rerender", async () => {
    const { editor, editable, onSaveNow, rerender, client } = renderEditor([
      configured(),
      paragraph("after"),
    ]);
    selectBase(editor, [0]);
    const table = screen.getByRole("button", { name: "Table entry" });
    table.focus();
    const selection = editor.selection;
    act(() => {
      onSaveNow();
    });
    expect(onSaveNow).toHaveBeenCalledOnce();
    rerender(
      <QueryClientProvider client={client}>
        <SlateEditor
          initialValue={[configured(), paragraph("after")]}
          onChange={vi.fn()}
          onSaveNow={onSaveNow}
        />
      </QueryClientProvider>,
    );
    expect(table).toHaveFocus();
    expect(editor.selection).toEqual(selection);
    expect(editable).toBeInTheDocument();
  });
});
