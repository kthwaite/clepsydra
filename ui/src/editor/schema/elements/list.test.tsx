import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createEditor, type Descendant } from "slate";
import { HistoryEditor, withHistory } from "slate-history";
import { Editable, Slate, withReact } from "slate-react";
import { describe, expect, it, vi } from "vitest";
import { slateToMarkdown } from "#/editor/convert";
import { renderElement } from "#/editor/elements/renderElement";
import type { BulletedListElement } from "#/editor/schema/types";
import { withSchema } from "#/editor/schema/withSchema";

function taskValue(): Descendant[] {
  return [
    {
      type: "bulleted-list",
      children: [
        {
          type: "list-item",
          checked: false,
          children: [
            {
              type: "paragraph",
              children: [{ text: "Buy milk" }],
            },
          ],
        },
      ],
    },
  ];
}

function renderTask(
  readOnly = false,
  initialValue: Descendant[] = taskValue(),
) {
  const editor = withReact(withHistory(withSchema(createEditor())));
  const onChange = vi.fn();
  render(
    <Slate editor={editor} initialValue={initialValue} onChange={onChange}>
      <Editable renderElement={renderElement} readOnly={readOnly} />
    </Slate>,
  );

  return { editor, onChange };
}

function renderedTask() {
  const listItem = screen.getByText("Buy milk").closest("li");
  if (!listItem) throw new Error("Rendered task is not inside a list item");
  return {
    listItem,
    checkbox: screen.getByRole("checkbox", { name: /buy milk/i }),
  };
}

describe("list item checkbox", () => {
  it("keeps the DOM, Slate node, Markdown, and one-step undo in agreement", async () => {
    const user = userEvent.setup();
    const { editor, onChange } = renderTask();
    const initialTask = renderedTask();

    await user.click(initialTask.checkbox);

    const checkedTask = renderedTask();
    expect(checkedTask.checkbox).toBeChecked();
    expect(checkedTask.listItem).toHaveClass("line-through");
    expect(
      (editor.children[0] as BulletedListElement).children[0].checked,
    ).toBe(true);
    expect(slateToMarkdown(editor.children)).toContain("[x] Buy milk");
    expect(onChange).toHaveBeenCalled();

    await act(async () => HistoryEditor.undo(editor));
    await waitFor(() =>
      expect(
        (editor.children[0] as BulletedListElement).children[0].checked,
      ).toBe(false),
    );

    const uncheckedTask = renderedTask();
    expect(uncheckedTask.checkbox).not.toBeChecked();
    expect(uncheckedTask.listItem).not.toHaveClass("line-through");
    expect(
      (editor.children[0] as BulletedListElement).children[0].checked,
    ).toBe(false);
    expect(slateToMarkdown(editor.children)).toContain("[ ] Buy milk");
  });

  it("does not mutate a task when the editor is read-only", async () => {
    const user = userEvent.setup();
    const { editor, onChange } = renderTask(true);
    const { checkbox, listItem } = renderedTask();
    const initialValue = structuredClone(editor.children);

    expect(checkbox).toBeDisabled();
    await user.click(checkbox);

    expect(checkbox).not.toBeChecked();
    expect(listItem).not.toHaveClass("line-through");
    expect(editor.children).toEqual(initialValue);
    expect(
      (editor.children[0] as BulletedListElement).children[0].checked,
    ).toBe(false);
    expect(slateToMarkdown(editor.children)).toContain("[ ] Buy milk");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps first-line alignment while giving the checkbox a 44px touch target", async () => {
    const user = userEvent.setup();
    renderTask();
    const { checkbox, listItem } = renderedTask();
    const control = checkbox.parentElement;
    if (!control) throw new Error("Checkbox has no touch target");

    expect(listItem).toHaveClass("items-baseline", "max-md:items-start");
    expect(control.tagName).toBe("LABEL");
    expect(control).toHaveClass(
      "size-4",
      "max-md:min-h-11",
      "max-md:min-w-11",
      "max-md:items-start",
    );
    expect(control).not.toHaveClass("before:absolute", "before:-inset-3.5");

    await user.click(control);

    expect(checkbox).toBeChecked();
  });

  it("uses in-flow touch targets for sibling and nested tasks", () => {
    const value: Descendant[] = [
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            checked: false,
            children: [
              {
                type: "paragraph",
                children: [{ text: "Parent task" }],
              },
              {
                type: "bulleted-list",
                children: [
                  {
                    type: "list-item",
                    checked: false,
                    children: [
                      {
                        type: "paragraph",
                        children: [{ text: "Nested task" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            type: "list-item",
            checked: false,
            children: [
              {
                type: "paragraph",
                children: [{ text: "Sibling task" }],
              },
            ],
          },
        ],
      },
    ];
    renderTask(false, value);

    const checkboxes = screen.getAllByRole("checkbox");
    const controls = checkboxes.map((checkbox) => checkbox.parentElement);
    const listItems = checkboxes.map((checkbox) => checkbox.closest("li"));
    expect(controls).toHaveLength(3);
    expect(listItems).toHaveLength(3);

    for (const control of controls) {
      expect(control).toHaveClass("max-md:min-h-11", "max-md:min-w-11");
      expect(control).not.toHaveClass(
        "before:absolute",
        "before:-inset-3.5",
      );
    }
    for (const listItem of listItems) {
      expect(listItem).toHaveClass("max-md:items-start");
      const content = listItem?.querySelector("[data-task-content]");
      expect(content).toHaveClass("min-w-0", "flex-1");
      expect(
        content?.querySelector("[data-task-content-row]"),
      ).toHaveClass("max-md:min-h-11");
    }

    expect(listItems[0]).toContainElement(listItems[1]);
    expect(listItems[0]).not.toContainElement(listItems[2]);
  });

  it("gives direct text an in-flow mobile row before a nested task", () => {
    const value: Descendant[] = [
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            checked: false,
            children: [
              { text: "Direct parent" },
              {
                type: "bulleted-list",
                children: [
                  {
                    type: "list-item",
                    checked: false,
                    children: [{ text: "Direct nested" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const { editor } = renderTask(false, value);

    const parentItem = screen.getByText("Direct parent").closest("li");
    const nestedItem = screen.getByText("Direct nested").closest("li");
    const parentContent = parentItem?.querySelector("[data-task-content]");

    expect(parentContent).toContainElement(nestedItem);
    const firstRow = parentContent?.querySelector("[data-task-content-row]");
    expect(firstRow).toHaveClass("max-md:min-h-11");
    expect(firstRow).toHaveTextContent("Direct parent");
    expect(firstRow).not.toContainElement(nestedItem);
    expect(slateToMarkdown(editor.children)).toContain(
      "* [ ] Direct parent\n  * [ ] Direct nested",
    );
  });

  it("keeps marked direct-text leaves together before a nested task", () => {
    const value: Descendant[] = [
      {
        type: "bulleted-list",
        children: [
          {
            type: "list-item",
            checked: false,
            children: [
              { text: "Multi " },
              { text: "marked", bold: true },
              { text: " text", italic: true },
              {
                type: "bulleted-list",
                children: [
                  {
                    type: "list-item",
                    checked: false,
                    children: [{ text: "Nested leaf" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const { editor } = renderTask(false, value);

    const parentItem = screen.getByText("Multi").closest("li");
    const nestedItem = screen.getByText("Nested leaf").closest("li");
    const content = parentItem?.querySelector("[data-task-content]");
    const firstRow = content?.querySelector("[data-task-content-row]");

    expect(firstRow).toHaveTextContent("Multi marked text");
    expect(firstRow).toContainElement(screen.getByText("marked"));
    expect(firstRow).toContainElement(screen.getByText("text"));
    expect(firstRow).not.toContainElement(nestedItem);
    expect(content).toContainElement(nestedItem);

    expect(slateToMarkdown(editor.children)).toBe(
      "* [ ] Multi&#x20;\n\n  **marked**\n\n  *&#x20;text*\n  * [ ] Nested leaf\n",
    );
  });
});
