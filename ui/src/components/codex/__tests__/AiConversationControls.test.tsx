import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AiConversationControls } from "#/components/codex/AiConversationControls";

describe("AiConversationControls", () => {
  it("draws the modes as a segmented track with the pressed mode raised", () => {
    render(
      <AiConversationControls
        mode="read"
        onModeChange={() => {}}
        onAddTurn={() => {}}
      />,
    );
    const group = screen.getByRole("group", { name: "Conversation mode" });
    expect(group).toHaveClass("bg-sink", "rounded-full");
    const read = within(group).getByRole("button", { name: "Read" });
    expect(read).toHaveAttribute("aria-pressed", "true");
    expect(read).toHaveClass("aria-pressed:bg-raise", "rounded-full");
    expect(group.closest("div")).not.toHaveClass("ai-conversation-controls");
  });

  it("offers Add turn as a ui button in Edit", async () => {
    const onAddTurn = vi.fn();
    render(
      <AiConversationControls
        mode="edit"
        onModeChange={() => {}}
        onAddTurn={onAddTurn}
      />,
    );
    const add = screen.getByRole("button", { name: "Add turn" });
    expect(add).toHaveClass("rounded-full");
    await userEvent.setup().click(add);
    expect(onAddTurn).toHaveBeenCalledOnce();
  });
});
