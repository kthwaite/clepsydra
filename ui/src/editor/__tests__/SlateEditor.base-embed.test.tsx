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
import { useRef, useState } from "react";
import {
  type Descendant,
  Editor,
  Node,
  type Path,
  Element as SlateElement,
  Transforms,
} from "slate";
import { ReactEditor } from "slate-react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IS_MAC } from "#/lib/shortcuts";

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
      props: Record<string, unknown>,
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
        <>
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
          <input aria-label="Member title" defaultValue="draft" />
          {/* Compact embeds hand their Edit and Remove controls to the table. */}
          {props.actions as React.ReactNode}
        </>
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
      return (
        this.closest("[contenteditable]")?.getAttribute("contenteditable") ===
        "true"
      );
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
  const editable = view.container.querySelector<HTMLElement>(
    '[contenteditable="true"]',
  );
  if (!editable) throw new Error("Slate Editable was not mounted");
  return {
    ...view,
    client,
    editor,
    editable,
    onChange,
    onSaveNow,
  };
}

function PersistenceRoundTripHarness({
  saveGate,
  onSaveStarted,
}: {
  saveGate: Promise<void>;
  onSaveStarted(): void;
}) {
  const [persisted, setPersisted] = useState<Descendant[]>([
    configured(),
    paragraph("after"),
  ]);
  const [roundTrips, setRoundTrips] = useState(0);
  const latest = useRef(persisted);
  return (
    <>
      <SlateEditor
        initialValue={persisted}
        onChange={(value) => {
          latest.current = value;
        }}
        onSaveNow={async () => {
          onSaveStarted();
          await saveGate;
          const markdown = slateToMarkdown(latest.current);
          setPersisted(markdownToSlate(markdown));
          setRoundTrips((count) => count + 1);
        }}
      />
      <output data-testid="persistence-round-trips">{roundTrips}</output>
      <output data-testid="persisted-markdown">
        {slateToMarkdown(persisted)}
      </output>
    </>
  );
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

  it.each(["Enter", "F2", "Backspace", "Delete"])(
    "leaves nested member-input %s ownership untouched while the Base void stays selected",
    async (key) => {
      const user = userEvent.setup();
      const { editor, editable } = renderEditor([
        configured(),
        paragraph("after"),
      ]);
      selectBase(editor, [0]);
      await focusSlate(editor, editable);
      const selection = structuredClone(editor.selection);
      const selected = editor.children[0];
      const memberTitle = screen.getByRole("textbox", {
        name: "Member title",
      });
      await user.click(memberTitle);
      expect(ReactEditor.isFocused(editor)).toBe(false);
      const editableTargetSpy = vi
        .spyOn(ReactEditor, "hasEditableTarget")
        .mockReturnValueOnce(true);

      try {
        const keyDown = new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        });
        act(() => {
          memberTitle.dispatchEvent(keyDown);
        });

        expect(keyDown.defaultPrevented).toBe(false);
        expect(memberTitle).toHaveFocus();
        expect(editor.children[0]).toBe(selected);
        expect(editor.selection).toEqual(selection);
      } finally {
        editableTargetSpy.mockRestore();
      }
    },
  );

  it.each([
    {
      key: "{Backspace}",
      selection: [5, 5] as const,
      expected: "draf",
    },
    { key: "{Delete}", selection: [0, 0] as const, expected: "raft" },
  ])(
    "$key keeps native text editing in the nested member input",
    async ({ key, selection, expected }) => {
      const user = userEvent.setup();
      const { editor, editable } = renderEditor([
        configured(),
        paragraph("after"),
      ]);
      selectBase(editor, [0]);
      await focusSlate(editor, editable);
      const slateSelection = structuredClone(editor.selection);
      const selected = editor.children[0];
      const memberTitle = screen.getByRole("textbox", {
        name: "Member title",
      }) as HTMLInputElement;
      await user.click(memberTitle);
      expect(ReactEditor.isFocused(editor)).toBe(false);
      memberTitle.setSelectionRange(selection[0], selection[1]);
      const editableTargetSpy = vi
        .spyOn(ReactEditor, "hasEditableTarget")
        .mockReturnValueOnce(true);

      try {
        await user.keyboard(key);

        expect(memberTitle).toHaveValue(expected);
        expect(memberTitle).toHaveFocus();
        expect(editor.children[0]).toBe(selected);
        expect(editor.selection).toEqual(slateSelection);
      } finally {
        editableTargetSpy.mockRestore();
      }
    },
  );

  it.each(["Backspace", "Delete"])(
    "%s removes a selected embed while Slate owns focus",
    async (key) => {
      const { editor, editable } = renderEditor([
        paragraph("before"),
        configured(),
        paragraph("after"),
      ]);
      selectBase(editor, [1]);
      await focusSlate(editor, editable);

      fireEvent.keyDown(editable, { key });

      expect(
        editor.children.some(
          (node) => SlateElement.isElement(node) && node.type === "base-embed",
        ),
      ).toBe(false);
      expect(editor.selection?.anchor.path[0]).toBe(1);
    },
  );

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

  it("preserves descendant focus and Slate selection through an async save round trip", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, enabled: false } },
    });
    let releaseSave = () => {};
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const onSaveStarted = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <PersistenceRoundTripHarness
          saveGate={saveGate}
          onSaveStarted={onSaveStarted}
        />
      </QueryClientProvider>,
    );
    const editor = harnessState.editor;
    if (!editor) throw new Error("Slate editor was not mounted");
    const editable = document.querySelector<HTMLElement>(
      '[contenteditable="true"]',
    );
    if (!editable) throw new Error("Slate Editable was not mounted");
    selectBase(editor, [0]);
    await focusSlate(editor, editable);
    fireEvent.keyDown(editable, {
      key: "s",
      ctrlKey: !IS_MAC,
      metaKey: IS_MAC,
    });
    expect(onSaveStarted).toHaveBeenCalledOnce();

    const table = screen.getByRole("button", { name: "Table entry" });
    table.focus();
    const selection = structuredClone(editor.selection);
    expect(table).toHaveFocus();
    act(() => releaseSave());
    await waitFor(() =>
      expect(screen.getByTestId("persistence-round-trips")).toHaveTextContent(
        "1",
      ),
    );
    expect(screen.getByTestId("persisted-markdown")).toHaveTextContent(
      'base = "reading"',
    );
    expect(table).toHaveFocus();
    expect(editor.selection).toEqual(selection);
  });
});
