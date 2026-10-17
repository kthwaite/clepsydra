import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { type Descendant, type Editor, Node, Transforms } from "slate";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { markdownToSlate, slateToMarkdown } from "#/editor/convert";
import { SlateEditor } from "#/editor/SlateEditor";
import type { ListItemElement } from "#/editor/schema/types";
import type { CustomEditor } from "#/editor/types";

// Navigation is the mounted editor's external boundary; do not require the
// application router merely to render inline page references.
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => vi.fn() }));

beforeAll(() => {
  // jsdom leaves isContentEditable unimplemented; slate-react's
  // hasEditableTarget guard needs it to route keydown to onKeyDown props.
  Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get(this: HTMLElement) {
      return this.closest('[contenteditable="true"]') !== null;
    },
  });
});

const TASK_PROPERTIES_CHORD = { key: "p", ctrlKey: true, shiftKey: true };
const VIM_TOGGLE_CHORD = { key: "v", ctrlKey: true, shiftKey: true };

function task(
  text: string,
  overrides: Partial<ListItemElement> = {},
): ListItemElement {
  return {
    type: "list-item",
    children: [{ type: "paragraph", children: [{ text }] }],
    ...overrides,
  };
}

function taskList(...items: ListItemElement[]): Descendant {
  return { type: "bulleted-list", children: items };
}

function renderEditor(initialValue: Descendant[], readOnly = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  client.setQueryData(["get", "/api/vault/pages", {}], {
    items: [
      {
        id: "ada",
        kind: "PERSON",
        title: "Ada Lovelace",
        canonical_name: "Ada Lovelace",
        path: "people/ada.md",
        aliases: [],
      },
      {
        id: "grace",
        kind: "PERSON",
        title: "Grace Hopper",
        canonical_name: "Grace Hopper",
        path: "people/grace.md",
        aliases: [],
      },
      {
        id: "report",
        kind: "NOTE",
        title: "Report",
        canonical_name: "Report",
        path: "notes/report.md",
        aliases: [],
      },
    ],
  });
  const editorRef = createRef<CustomEditor>();
  // Mirrors usePageEditor's dirty rule: only non-selection operations count.
  let astChanges = 0;

  const renderTree = (protectedMode: boolean) => (
    <QueryClientProvider client={client}>
      <SlateEditor
        initialValue={initialValue}
        editorRef={editorRef}
        readOnly={protectedMode}
        onChange={(_value, editor) => {
          if (editor.operations.some((op) => op.type !== "set_selection")) {
            astChanges += 1;
          }
        }}
        onSaveNow={() => {}}
      />
    </QueryClientProvider>
  );
  const rendered = render(renderTree(readOnly));

  const editor = () => editorRef.current as Editor;
  return {
    editor,
    unmount: rendered.unmount,
    setReadOnly: (value: boolean) => rendered.rerender(renderTree(value)),
    astChanges: () => astChanges,
    item: (path: number[]) => Node.get(editor(), path) as ListItemElement,
    editable: () => screen.getByRole("textbox"),
    caretAt: (path: number[], offset = 0) => {
      act(() => {
        Transforms.select(editor(), { path, offset });
      });
    },
  };
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "Todo properties" });
}

describe("SlateEditor task property popover", () => {
  it("keeps inline-code property examples as body text, not assignment or priority", () => {
    const markdown =
      "- [ ] Example `[assignee:: [[Ada Lovelace]]] [priority:: A]` [estimate:: 2h]\n";
    const view = renderEditor(markdownToSlate(markdown));
    expect(
      screen
        .getByText("[assignee:: [[Ada Lovelace]]] [priority:: A]")
        .closest("code"),
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Assignee Ada Lovelace" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Priority High" })).toBeNull();
    expect(slateToMarkdown(view.editor().children)).toContain(
      "`[assignee:: [[Ada Lovelace]]] [priority:: A]` [estimate:: 2h]",
    );
  });
  it("loads linked assignment without losing formatting, nested ownership or ordinary links", async () => {
    const user = userEvent.setup();
    const view = renderEditor(
      markdownToSlate(
        "- [ ] Send **report** to [[Client]] [assignee:: [[Ada Lovelace]]] [estimate:: 3h]\n  - [ ] Child [assignee:: [[Grace Hopper|Grace]]]\n",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Assignee Ada Lovelace" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Assignee Grace" }),
    ).toBeVisible();
    expect(screen.getByText("report").closest("strong")).not.toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Assignee Ada Lovelace" }),
    );
    expect(
      within(dialog()).getByRole("option", { name: "Ada Lovelace" }),
    ).toHaveProperty("selected", true);
    await user.click(
      within(dialog()).getByRole("button", { name: "Clear assignee" }),
    );
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(slateToMarkdown(view.editor().children)).toContain(
      "[assignee:: [[Ada Lovelace]]]",
    );
    await user.click(
      screen.getByRole("button", { name: "Assignee Ada Lovelace" }),
    );
    await user.click(
      within(dialog()).getByRole("button", { name: "Clear assignee" }),
    );
    await user.click(within(dialog()).getByRole("button", { name: "Apply" }));
    const saved = slateToMarkdown(view.editor().children);
    expect(saved).not.toContain("[assignee:: [[Ada Lovelace]]]");
    expect(saved).toContain("**report**");
    expect(saved).toContain("[[Client]]");
    expect(saved).toContain("[estimate:: 3h]");
    expect(saved).toContain("[assignee:: [[Grace Hopper|Grace]]]");
    expect(slateToMarkdown(markdownToSlate(saved))).toBe(saved);
  });
  it("chooses and changes exactly one PERSON, then preserves it on completion and reload", async () => {
    const user = userEvent.setup();
    const view = renderEditor(
      markdownToSlate("- [ ] Send **report** [priority:: A]\n"),
    );
    await user.click(screen.getByRole("button", { name: "Priority High" }));
    const select = within(dialog()).getByRole("combobox", {
      name: "Assignee (Person)",
    });
    expect(within(select).queryByRole("option", { name: "Report" })).toBeNull();
    await user.selectOptions(select, "[[people/ada.md|Ada Lovelace]]");
    await user.click(within(dialog()).getByRole("button", { name: "Apply" }));
    await user.click(
      screen.getByRole("button", { name: "Assignee Ada Lovelace" }),
    );
    await user.selectOptions(
      within(dialog()).getByRole("combobox", { name: "Assignee (Person)" }),
      "[[people/grace.md|Grace Hopper]]",
    );
    await user.click(within(dialog()).getByRole("button", { name: "Apply" }));
    await user.click(screen.getByRole("checkbox"));
    const saved = slateToMarkdown(view.editor().children);
    expect(saved).toContain("[assignee:: [[people/grace.md|Grace Hopper]]]");
    expect(saved).not.toContain("people/ada.md");
    expect(saved).toContain("[priority:: A]");
    view.unmount();
    renderEditor(markdownToSlate(saved));
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByText("report").closest("strong")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Assignee Grace Hopper" }),
    ).toBeVisible();
  });

  it("autoformats a linked property after the inner wikilink has become a void", async () => {
    const view = renderEditor([
      taskList(task("Send report ", { checked: false })),
    ]);
    view.caretAt([0, 0, 0, 0], "Send report ".length);
    // jsdom cannot type into contenteditable: use the real mounted editor's
    // insertion pipeline, including wikilink and property autoformat.
    await act(async () => {
      for (const character of "[assignee:: [[Ada Lovelace]]]")
        view.editor().insertText(character);
    });
    expect(
      await screen.findByRole("button", { name: "Assignee Ada Lovelace" }),
    ).toBeVisible();
    expect(slateToMarkdown(view.editor().children)).toContain(
      "Send report [assignee:: [[Ada Lovelace]]]",
    );
  });

  it("shows assignment without allowing protected TODO mutations", () => {
    const view = renderEditor(
      markdownToSlate("- [ ] Send report [assignee:: [[Ada Lovelace]]]\n"),
      true,
    );
    expect(
      screen.queryByRole("button", { name: "Assignee Ada Lovelace" }),
    ).toBeNull();
    expect(screen.getByRole("link", { name: "Ada Lovelace" })).toBeVisible();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    fireEvent.keyDown(
      screen.getByRole("link", { name: "Ada Lovelace" }),
      TASK_PROPERTIES_CHORD,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(view.astChanges()).toBe(0);
  });

  it("discards an open assignment draft when the Folio becomes read-only", async () => {
    const user = userEvent.setup();
    const view = renderEditor(
      markdownToSlate("- [ ] Send report [assignee:: [[Ada Lovelace]]]\n"),
    );
    await user.click(
      screen.getByRole("button", { name: "Assignee Ada Lovelace" }),
    );
    await user.selectOptions(
      within(dialog()).getByRole("combobox", { name: "Assignee (Person)" }),
      "[[people/grace.md|Grace Hopper]]",
    );
    view.setReadOnly(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    view.setReadOnly(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(slateToMarkdown(view.editor().children)).toContain(
      "[assignee:: [[Ada Lovelace]]]",
    );
    expect(view.astChanges()).toBe(0);
  });
  it("opens from a chip with the item's current values prefilled", async () => {
    const user = userEvent.setup();
    renderEditor([
      taskList(
        task("Ship the picker", {
          checked: false,
          properties: { due: "2026-08-20", priority: "B" },
        }),
      ),
    ]);

    await user.click(screen.getByRole("button", { name: "Due 2026-08-20" }));

    const popover = dialog();
    expect(within(popover).getByLabelText("Due")).toHaveValue("2026-08-20");
    // Initial focus is enqueued on the next frame by the focus manager.
    await waitFor(() =>
      expect(within(popover).getByLabelText("Due")).toHaveFocus(),
    );
    expect(within(popover).getByLabelText("Scheduled")).toHaveValue("");
    expect(
      within(popover).getByRole("button", { name: "Medium" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(popover).getByRole("button", { name: "High" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("opens an empty draft from the hover control", async () => {
    const user = userEvent.setup();
    renderEditor([taskList(task("No properties yet", { checked: false }))]);

    await user.click(screen.getByRole("button", { name: "Todo properties" }));

    const popover = dialog();
    expect(within(popover).getByLabelText("Due")).toHaveValue("");
    expect(within(popover).getByLabelText("Scheduled")).toHaveValue("");
    for (const level of ["High", "Medium", "Low"]) {
      expect(
        within(popover).getByRole("button", { name: level }),
      ).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("opens for the task item at the caret on the registry chord", async () => {
    const view = renderEditor([
      taskList(task("First", { checked: false })),
      { type: "paragraph", children: [{ text: "Plain paragraph" }] },
    ]);
    view.caretAt([0, 0, 0, 0]);

    const consumed = !fireEvent.keyDown(view.editable(), TASK_PROPERTIES_CHORD);

    expect(consumed).toBe(true);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("leaves the chord alone when the caret is not in a task item", async () => {
    const view = renderEditor([
      taskList(task("First", { checked: false })),
      { type: "paragraph", children: [{ text: "Plain paragraph" }] },
    ]);
    view.caretAt([1, 0]);

    const consumed = !fireEvent.keyDown(view.editable(), TASK_PROPERTIES_CHORD);

    expect(consumed).toBe(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens from the chord while vim mode owns the editable", async () => {
    const view = renderEditor([taskList(task("Vim task", { checked: false }))]);
    fireEvent.keyDown(view.editable(), VIM_TOGGLE_CHORD);
    expect(screen.getByText("NORMAL")).toBeInTheDocument();
    view.caretAt([0, 0, 0, 0]);

    fireEvent.keyDown(view.editable(), TASK_PROPERTIES_CHORD);

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    // The popover renders outside the Editable, so its keys never reach the
    // vim handler — "x" edits the date field, not the document.
    fireEvent.keyDown(within(dialog()).getByLabelText("Due"), { key: "x" });
    expect(Node.string(view.item([0, 0]))).toBe("Vim task");
  });

  it("commits the draft on Enter and preserves non-task properties", async () => {
    const user = userEvent.setup();
    const view = renderEditor([
      taskList(
        task("Ship the picker", {
          checked: false,
          properties: { estimate: "3h" },
        }),
      ),
    ]);

    await user.click(screen.getByRole("button", { name: "Todo properties" }));
    const due = within(dialog()).getByLabelText("Due");
    fireEvent.change(due, { target: { value: "2026-09-01" } });
    await user.click(within(dialog()).getByRole("button", { name: "High" }));
    fireEvent.keyDown(due, { key: "Enter" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(view.item([0, 0]).properties).toEqual({
      estimate: "3h",
      due: "2026-09-01",
      priority: "A",
    });
    expect(
      screen.getByRole("button", { name: "Due 2026-09-01" }),
    ).toBeInTheDocument();
  });

  it("unsets the record when every task property is cleared", async () => {
    const user = userEvent.setup();
    const view = renderEditor([
      taskList(
        task("Ship the picker", {
          checked: false,
          properties: { due: "2026-08-20", priority: "A" },
        }),
      ),
    ]);

    await user.click(screen.getByRole("button", { name: "Due 2026-08-20" }));
    await user.click(
      within(dialog()).getByRole("button", { name: "Clear due" }),
    );
    // A second press on the active level clears priority.
    await user.click(within(dialog()).getByRole("button", { name: "High" }));
    fireEvent.keyDown(within(dialog()).getByLabelText("Scheduled"), {
      key: "Enter",
    });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(view.item([0, 0])).not.toHaveProperty("properties");
  });

  it("discards the draft on Escape", async () => {
    const user = userEvent.setup();
    const view = renderEditor([
      taskList(
        task("Ship the picker", {
          checked: false,
          properties: { due: "2026-08-20" },
        }),
      ),
    ]);

    await user.click(screen.getByRole("button", { name: "Due 2026-08-20" }));
    fireEvent.change(within(dialog()).getByLabelText("Due"), {
      target: { value: "2026-09-01" },
    });
    fireEvent.keyDown(within(dialog()).getByLabelText("Due"), {
      key: "Escape",
    });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(view.item([0, 0]).properties).toEqual({ due: "2026-08-20" });
    expect(view.astChanges()).toBe(0);
  });

  it("commits on outside interaction and returns focus to the editable", async () => {
    const user = userEvent.setup();
    const view = renderEditor([
      taskList(task("Ship the picker", { checked: false })),
    ]);

    await user.click(screen.getByRole("button", { name: "Todo properties" }));
    fireEvent.change(within(dialog()).getByLabelText("Scheduled"), {
      target: { value: "2026-08-15" },
    });
    fireEvent.pointerDown(document.body);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(view.item([0, 0]).properties).toEqual({ scheduled: "2026-08-15" });
    await waitFor(() => expect(view.editable()).toHaveFocus());
  });

  it("leaves the editor clean when the draft changes nothing", async () => {
    const user = userEvent.setup();
    const view = renderEditor([
      taskList(
        task("Ship the picker", {
          checked: false,
          properties: { due: "2026-08-20" },
        }),
      ),
    ]);
    const before = view.item([0, 0]);

    await user.click(screen.getByRole("button", { name: "Due 2026-08-20" }));
    fireEvent.keyDown(within(dialog()).getByLabelText("Due"), { key: "Enter" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(view.item([0, 0])).toBe(before);
    expect(view.astChanges()).toBe(0);
  });

  it("closes without writing when the item is deleted while open", async () => {
    const user = userEvent.setup();
    const view = renderEditor([
      taskList(
        task("Keep me", { checked: false }),
        task("Delete me", {
          checked: false,
          properties: { due: "2026-08-20" },
        }),
      ),
    ]);

    await user.click(screen.getByRole("button", { name: "Due 2026-08-20" }));
    fireEvent.change(within(dialog()).getByLabelText("Due"), {
      target: { value: "2026-09-01" },
    });
    act(() => {
      Transforms.removeNodes(view.editor(), { at: [0, 1] });
    });
    fireEvent.keyDown(within(dialog()).getByLabelText("Due"), { key: "Enter" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(view.item([0, 0])).not.toHaveProperty("properties");
    expect(screen.queryByRole("button", { name: "Due 2026-09-01" })).toBeNull();
    // The deletion is the only AST change; the dropped draft adds none.
    expect(view.astChanges()).toBe(1);
  });
});
