import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InlineSourceInput } from "#/editor/InlineSourceInput";
import type {
  SourceCaretEdge,
  SourceParseResult,
} from "#/editor/inlineSourceEditing";
import { wikilinkSourceAdapter } from "#/editor/wikilinkSourceAdapter";

interface RenderEditorOptions {
  initialDraft?: string;
  initialCaret?: SourceCaretEdge;
  parse?: (draft: string) => SourceParseResult;
  returnSide?: "before" | "after";
}

function renderEditor({
  initialDraft = "Target|Label",
  initialCaret = "end",
  returnSide = "after",
  parse = wikilinkSourceAdapter.parse,
}: RenderEditorOptions = {}) {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  const onOpen = vi.fn();
  render(
    <InlineSourceInput
      label="Edit wikilink"
      parse={parse}
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

describe("InlineSourceInput", () => {
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

  it("opts the source input out of spellcheck", () => {
    const { input } = renderEditor();

    expect(input).toHaveAttribute("spellcheck", "false");
  });

  it.each([
    {
      name: "Enter",
      initialCaret: "end",
      event: { key: "Enter", isComposing: true },
    },
    {
      name: "Cmd+Enter",
      initialCaret: "end",
      event: { key: "Enter", metaKey: true, isComposing: true },
    },
    {
      name: "Escape",
      initialCaret: "end",
      event: { key: "Escape", isComposing: true },
    },
    {
      name: "ArrowLeft at the start boundary",
      initialCaret: "start",
      event: { key: "ArrowLeft", isComposing: true },
    },
    {
      name: "ArrowRight at the end boundary",
      initialCaret: "end",
      event: { key: "ArrowRight", isComposing: true },
    },
    {
      name: "legacy keyCode 229 Enter",
      initialCaret: "end",
      event: { key: "Enter", keyCode: 229, metaKey: true },
    },
  ] as const)(
    "ignores $name while an IME composition is active",
    ({ initialCaret, event }) => {
      const { input, onCommit, onCancel, onOpen } = renderEditor({
        initialCaret,
      });

      fireEvent.keyDown(input, event);

      expect(input).toHaveFocus();
      expect(onCommit).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
      expect(onOpen).not.toHaveBeenCalled();
    },
  );

  it("commits before when ArrowLeft is pressed at offset zero", async () => {
    const user = userEvent.setup();
    const { input, onCommit } = renderEditor({ initialCaret: "start" });

    await user.keyboard("{ArrowLeft}");

    expect(input).toHaveFocus();
    expect(onCommit).toHaveBeenCalledWith("Target|Label", "before");
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

    expect(onCommit).toHaveBeenCalledWith("Target|Label", "after");
  });

  it("commits after on Enter", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderEditor();

    await user.keyboard("{Enter}");

    expect(onCommit).toHaveBeenCalledWith("Target|Label", "after");
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

    expect(onCommit).toHaveBeenCalledWith("Target|Label", "preserve");
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

    expect(onCommit).toHaveBeenCalledWith("Target|Label", "after");
    expect(onOpen).toHaveBeenCalledWith("Target|Label");
    expect(onCommit.mock.invocationCallOrder[0]).toBeLessThan(
      onOpen.mock.invocationCallOrder[0],
    );
  });

  it("commits and opens a valid draft on Ctrl+Enter", async () => {
    const user = userEvent.setup();
    const { onCommit, onOpen } = renderEditor();

    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(onCommit).toHaveBeenCalledWith("Target|Label", "after");
    expect(onOpen).toHaveBeenCalledWith("Target|Label");
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

    expect(onCommit).toHaveBeenCalledWith("Target|Label|More", "after");
  });

  it("does not commit again when a key-triggered exit is followed by blur", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderEditor();

    await user.keyboard("{Enter}");
    await user.tab();

    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  describe("invalid drafts", () => {
    const strictParse = (draft: string): SourceParseResult =>
      draft === ""
        ? { kind: "cancel" }
        : /^[a-z]+$/.test(draft)
          ? { kind: "commit", apply: () => {} }
          : { kind: "invalid" };

    it("marks the input aria-invalid while the draft is invalid", async () => {
      const user = userEvent.setup();
      const { input } = renderEditor({
        initialDraft: "abc",
        parse: strictParse,
      });

      expect(input).not.toHaveAttribute("aria-invalid", "true");
      await user.keyboard("1");
      expect(input).toHaveAttribute("aria-invalid", "true");
      await user.keyboard("{Backspace}");
      expect(input).not.toHaveAttribute("aria-invalid", "true");
    });

    it("ignores Enter and Cmd+Enter on an invalid draft", async () => {
      const user = userEvent.setup();
      const { input, onCommit, onCancel, onOpen } = renderEditor({
        initialDraft: "abc1",
        parse: strictParse,
      });

      await user.keyboard("{Enter}");
      await user.keyboard("{Meta>}{Enter}{/Meta}");

      expect(input).toHaveFocus();
      expect(onCommit).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
      expect(onOpen).not.toHaveBeenCalled();
    });

    it("still cancels an invalid draft on Escape", async () => {
      const user = userEvent.setup();
      const { onCommit, onCancel } = renderEditor({
        initialDraft: "abc1",
        parse: strictParse,
      });

      await user.keyboard("{Escape}");

      expect(onCancel).toHaveBeenCalledWith("after");
      expect(onCommit).not.toHaveBeenCalled();
    });

    it.each([
      ["{ArrowRight}", "end", "after"],
      ["{ArrowLeft}", "start", "before"],
    ] as const)(
      "cancels an invalid draft on the %s edge exit",
      async (key, initialCaret, exit) => {
        const user = userEvent.setup();
        const { onCommit, onCancel } = renderEditor({
          initialDraft: "abc1",
          initialCaret,
          parse: strictParse,
        });

        await user.keyboard(key);

        expect(onCancel).toHaveBeenCalledWith(exit);
        expect(onCommit).not.toHaveBeenCalled();
      },
    );

    it("cancels an invalid draft with preserve on blur", async () => {
      const user = userEvent.setup();
      const { onCommit, onCancel } = renderEditor({
        initialDraft: "abc1",
        parse: strictParse,
      });

      await user.tab();

      expect(onCancel).toHaveBeenCalledWith("preserve");
      expect(onCommit).not.toHaveBeenCalled();
    });
  });
});
