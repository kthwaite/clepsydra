import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WikilinkInlineEditor } from "#/editor/WikilinkInlineEditor";
import type { WikilinkCaretEdge } from "#/editor/wikilinkEditing";

interface RenderEditorOptions {
  initialDraft?: string;
  initialCaret?: WikilinkCaretEdge;
  returnSide?: "before" | "after";
}

function renderEditor({
  initialDraft = "Target|Label",
  initialCaret = "end",
  returnSide = "after",
}: RenderEditorOptions = {}) {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  const onOpen = vi.fn();
  render(
    <WikilinkInlineEditor
      initialDraft={initialDraft}
      initialCaret={initialCaret}
      returnSide={returnSide}
      onCommit={onCommit}
      onCancel={onCancel}
      onOpen={onOpen}
    />,
  );
  const input = screen.getByRole("textbox", {
    name: "Edit wikilink",
  }) as HTMLInputElement;
  return { input, onCommit, onCancel, onOpen };
}

describe("WikilinkInlineEditor", () => {
  it("renders the draft and places the caret at the requested start edge", () => {
    const { input } = renderEditor({ initialCaret: "start" });

    expect(input).toHaveValue("Target|Label");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(0);
  });

  it("places the caret at the draft end when requested", () => {
    const { input } = renderEditor({ initialCaret: "end" });

    expect(input.selectionStart).toBe("Target|Label".length);
    expect(input.selectionEnd).toBe("Target|Label".length);
  });

  it("commits before when ArrowLeft is pressed at offset zero", async () => {
    const user = userEvent.setup();
    const { input, onCommit } = renderEditor({ initialCaret: "start" });

    await user.keyboard("{ArrowLeft}");

    expect(input).toHaveFocus();
    expect(onCommit).toHaveBeenCalledWith(
      { target: "Target", alias: "Label" },
      "before",
    );
  });

  it("does not exit when ArrowLeft is pressed away from offset zero", async () => {
    const user = userEvent.setup();
    const { input, onCommit, onCancel } = renderEditor();
    input.setSelectionRange(3, 3);

    await user.keyboard("{ArrowLeft}");

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("commits after when ArrowRight is pressed at the draft end", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderEditor();

    await user.keyboard("{ArrowRight}");

    expect(onCommit).toHaveBeenCalledWith(
      { target: "Target", alias: "Label" },
      "after",
    );
  });

  it("commits after on Enter", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderEditor();

    await user.keyboard("{Enter}");

    expect(onCommit).toHaveBeenCalledWith(
      { target: "Target", alias: "Label" },
      "after",
    );
  });

  it("cancels to the return side on Escape without committing", async () => {
    const user = userEvent.setup();
    const { onCommit, onCancel } = renderEditor({ returnSide: "before" });

    await user.keyboard("{Escape}");

    expect(onCancel).toHaveBeenCalledWith("before");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits with a preserved selection on blur", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderEditor();

    await user.tab();

    expect(onCommit).toHaveBeenCalledWith(
      { target: "Target", alias: "Label" },
      "preserve",
    );
  });

  it.each([
    ["{ArrowLeft}", "start", "before"],
    ["{ArrowRight}", "end", "after"],
    ["{Enter}", "end", "after"],
  ] as const)(
    "cancels an invalid draft on normal %s exit",
    async (key, initialCaret, exit) => {
      const user = userEvent.setup();
      const { onCommit, onCancel } = renderEditor({
        initialDraft: " |Label",
        initialCaret,
      });

      await user.keyboard(key);

      expect(onCancel).toHaveBeenCalledWith(exit);
      expect(onCommit).not.toHaveBeenCalled();
    },
  );

  it("cancels an invalid draft with preserve on blur", async () => {
    const user = userEvent.setup();
    const { onCommit, onCancel } = renderEditor({ initialDraft: "|Label" });

    await user.tab();

    expect(onCancel).toHaveBeenCalledWith("preserve");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits and opens a valid draft on Cmd+Enter", async () => {
    const user = userEvent.setup();
    const { onCommit, onOpen } = renderEditor();

    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(onCommit).toHaveBeenCalledWith(
      { target: "Target", alias: "Label" },
      "after",
    );
    expect(onOpen).toHaveBeenCalledWith("Target");
    expect(onCommit.mock.invocationCallOrder[0]).toBeLessThan(
      onOpen.mock.invocationCallOrder[0],
    );
  });

  it("commits and opens a valid draft on Ctrl+Enter", async () => {
    const user = userEvent.setup();
    const { onCommit, onOpen } = renderEditor();

    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(onCommit).toHaveBeenCalledWith(
      { target: "Target", alias: "Label" },
      "after",
    );
    expect(onOpen).toHaveBeenCalledWith("Target");
  });

  it("keeps an invalid Cmd+Enter draft focused without callbacks", async () => {
    const user = userEvent.setup();
    const { input, onCommit, onCancel, onOpen } = renderEditor({
      initialDraft: "|Label",
    });

    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(input).toHaveFocus();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps additional pipes in the parsed alias", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderEditor({ initialDraft: "Target|Label|More" });

    await user.keyboard("{Enter}");

    expect(onCommit).toHaveBeenCalledWith(
      { target: "Target", alias: "Label|More" },
      "after",
    );
  });

  it("does not commit again when a key-triggered exit is followed by blur", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderEditor();

    await user.keyboard("{Enter}");
    await user.tab();

    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
