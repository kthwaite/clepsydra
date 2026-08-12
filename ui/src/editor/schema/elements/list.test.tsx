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

function renderTask(readOnly = false) {
  const editor = withReact(withHistory(withSchema(createEditor())));
  const onChange = vi.fn();
  render(
    <Slate editor={editor} initialValue={taskValue()} onChange={onChange}>
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
});
