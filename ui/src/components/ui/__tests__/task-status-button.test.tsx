import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TaskStatusButton } from "#/components/ui/task-status-button";

describe("TaskStatusButton", () => {
  it("renders with aria-label for current action", () => {
    render(<TaskStatusButton status="todo" onToggle={() => {}} />);
    expect(
      screen.getByRole("button", { name: "Mark task done" }),
    ).toBeDefined();
  });

  it("renders done action for doing status", () => {
    render(<TaskStatusButton status="doing" onToggle={() => {}} />);
    expect(
      screen.getByRole("button", { name: "Mark task done" }),
    ).toBeDefined();
  });

  it("renders todo action for done status", () => {
    render(<TaskStatusButton status="done" onToggle={() => {}} />);
    expect(
      screen.getByRole("button", { name: "Mark task todo" }),
    ).toBeDefined();
  });

  it("renders todo action for cancelled status", () => {
    render(<TaskStatusButton status="cancelled" onToggle={() => {}} />);
    expect(
      screen.getByRole("button", { name: "Mark task todo" }),
    ).toBeDefined();
  });

  it("fires onToggle on click", async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(<TaskStatusButton status="todo" onToggle={handler} />);
    await user.click(screen.getByRole("button"));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not fire onToggle when disabled", async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(<TaskStatusButton status="todo" onToggle={handler} isDisabled />);
    await user.click(screen.getByRole("button"));
    expect(handler).not.toHaveBeenCalled();
  });
});
