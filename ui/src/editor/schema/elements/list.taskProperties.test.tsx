import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createEditor, type Descendant, type Path } from "slate";
import { withHistory } from "slate-history";
import { Editable, Slate, withReact } from "slate-react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderElement } from "#/editor/elements/renderElement";
import type { ListItemElement } from "#/editor/schema/types";
import { withSchema } from "#/editor/schema/withSchema";
import { TaskPropertyPopoverProvider } from "#/editor/taskPropertyContext";

beforeAll(() => {
  // jsdom never reports contentEditable inheritance; user-event needs it to
  // treat controls inside the editable as clickable.
  Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get(this: HTMLElement) {
      return this.closest('[contenteditable="true"]') !== null;
    },
  });
});

function item(
  text: string,
  overrides: Partial<ListItemElement> = {},
): ListItemElement {
  return {
    type: "list-item",
    children: [{ type: "paragraph", children: [{ text }] }],
    ...overrides,
  };
}

function list(...items: ListItemElement[]): Descendant[] {
  return [{ type: "bulleted-list", children: items }];
}

interface RenderOptions {
  readOnly?: boolean;
  openForPath?: (path: Path, anchor: HTMLElement) => void;
}

function renderList(value: Descendant[], options: RenderOptions = {}) {
  const editor = withReact(withHistory(withSchema(createEditor())));
  const editable = (
    <Slate editor={editor} initialValue={value}>
      <Editable renderElement={renderElement} readOnly={options.readOnly} />
    </Slate>
  );
  render(
    options.openForPath ? (
      <TaskPropertyPopoverProvider value={{ openForPath: options.openForPath }}>
        {editable}
      </TaskPropertyPopoverProvider>
    ) : (
      editable
    ),
  );
  return editor;
}

function chipContainer(text: string): HTMLElement {
  const listItem = screen.getByText(text).closest("li");
  if (!listItem) throw new Error(`No list item renders ${text}`);
  const container = listItem.querySelector<HTMLElement>(
    "[data-task-properties]",
  );
  if (!container) throw new Error(`No property chips render for ${text}`);
  return container;
}

describe("task property chips", () => {
  it("stamps one chip per set property, in ledger order", () => {
    renderList(
      list(
        item("Ship the picker", {
          checked: false,
          properties: {
            priority: "A",
            due: "2026-08-20",
            scheduled: "2026-08-15",
          },
        }),
      ),
    );

    const due = screen.getByRole("button", { name: "Due 2026-08-20" });
    const scheduled = screen.getByRole("button", {
      name: "Scheduled 2026-08-15",
    });
    const priority = screen.getByRole("button", { name: "Priority HIGH" });

    expect(due).toHaveTextContent("DUE 2026-08-20");
    expect(scheduled).toHaveTextContent("SCHED 2026-08-15");
    expect(priority).toHaveTextContent("HIGH");
    expect(Array.from(chipContainer("Ship the picker").children)).toEqual([
      due,
      scheduled,
      priority,
    ]);
    expect(
      screen.queryByRole("button", { name: "Task properties" }),
    ).toBeNull();
  });

  it("renders only the keys that carry a value", () => {
    renderList(
      list(
        item("Partial", {
          checked: true,
          properties: { due: "2026-08-20", scheduled: "", other: "ignored" },
        }),
      ),
    );

    expect(chipContainer("Partial").children).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Due 2026-08-20" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/SCHED/)).toBeNull();
    expect(screen.queryByText(/ignored/i)).toBeNull();
  });

  it("maps priority A/B/C to HIGH/MED/LOW and passes anything else through", () => {
    renderList(
      list(
        item("alpha", { checked: false, properties: { priority: "A" } }),
        item("bravo", { checked: false, properties: { priority: "B" } }),
        item("charlie", { checked: false, properties: { priority: "C" } }),
        item("other", { checked: false, properties: { priority: "P1" } }),
      ),
    );

    expect(chipContainer("alpha")).toHaveTextContent("HIGH");
    expect(chipContainer("bravo")).toHaveTextContent("MED");
    expect(chipContainer("charlie")).toHaveTextContent("LOW");
    expect(chipContainer("other")).toHaveTextContent("P1");
    expect(
      screen.getByRole("button", { name: "Priority P1" }),
    ).toBeInTheDocument();
  });

  it("leaves plain bullets bare even when they carry the same properties", () => {
    renderList(
      list(item("just a bullet", { properties: { due: "2026-08-20" } })),
    );

    const listItem = screen.getByText("just a bullet").closest("li");
    expect(listItem?.querySelector("[data-task-properties]")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers a hover-revealed control on a task with no properties", () => {
    renderList(list(item("no properties yet", { checked: false })));

    const control = screen.getByRole("button", { name: "Task properties" });
    expect(control).toHaveTextContent("+");
    expect(control).toHaveClass("opacity-0", "group-hover:opacity-100");
    expect(screen.getByText("no properties yet").closest("li")).toHaveClass(
      "group",
    );
  });

  it("keeps chips out of the content column when the task nests a sub-list", () => {
    renderList([
      {
        type: "bulleted-list",
        children: [
          item("parent task", {
            checked: false,
            properties: { due: "2026-08-20" },
            children: [
              { type: "paragraph", children: [{ text: "parent task" }] },
              {
                type: "bulleted-list",
                children: [item("nested child")],
              },
            ],
          }),
        ],
      },
    ]);

    const listItem = screen.getByText("parent task").closest("li");
    if (!listItem) throw new Error("No list item renders the parent task");
    const content = listItem.querySelector<HTMLElement>("[data-task-content]");
    const chips = chipContainer("parent task");
    const chip = screen.getByRole("button", { name: "Due 2026-08-20" });

    expect(content).toContainElement(screen.getByText("nested child"));
    expect(content).not.toContainElement(chip);
    expect(chips.parentElement).toBe(listItem);
    expect(content?.parentElement).toBe(listItem);
    expect(chips.previousElementSibling).toBe(content);
  });

  it("holds the chips outside the editable content", () => {
    renderList(
      list(
        item("inert", { checked: false, properties: { due: "2026-08-20" } }),
      ),
    );

    expect(chipContainer("inert")).toHaveAttribute("contenteditable", "false");
  });

  it("asks the popover controller to open for the clicked item's path", async () => {
    const user = userEvent.setup();
    const openForPath = vi.fn();
    renderList(
      list(
        item("first", { checked: false }),
        item("second", {
          checked: false,
          properties: { scheduled: "2026-08-15" },
        }),
      ),
      { openForPath },
    );

    const chip = screen.getByRole("button", { name: "Scheduled 2026-08-15" });
    await user.click(chip);

    expect(openForPath).toHaveBeenCalledTimes(1);
    expect(openForPath).toHaveBeenCalledWith([0, 1], chip);

    const control = screen.getByRole("button", { name: "Task properties" });
    await user.click(control);

    expect(openForPath).toHaveBeenCalledTimes(2);
    expect(openForPath).toHaveBeenLastCalledWith([0, 0], control);
  });

  it("no-ops when no popover controller is mounted", async () => {
    const user = userEvent.setup();
    const editor = renderList(
      list(
        item("orphan", { checked: false, properties: { due: "2026-08-20" } }),
      ),
    );
    const before = structuredClone(editor.children);

    await user.click(screen.getByRole("button", { name: "Due 2026-08-20" }));

    expect(editor.children).toEqual(before);
  });

  it("keeps chips readable but inert in a read-only editor", () => {
    renderList(
      list(
        item("read only", {
          checked: false,
          properties: { due: "2026-08-20" },
        }),
        item("read only bare", { checked: false }),
      ),
      { readOnly: true },
    );

    expect(
      screen.getByRole("button", { name: "Due 2026-08-20" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Task properties" }),
    ).toBeNull();
  });
});
