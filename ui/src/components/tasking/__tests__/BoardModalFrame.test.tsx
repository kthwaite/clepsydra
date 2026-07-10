import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { BoardModalFrame } from "../BoardModalFrame";

it("renders the accessible modal shell with the requested contract", () => {
  const onClose = vi.fn();

  render(
    <BoardModalFrame
      ariaLabel="Test Board Dialog"
      widthClassName="w-[460px]"
      backdropTestId="test-backdrop"
      modalTestId="test-panel"
      onClose={onClose}
    >
      <button type="button">Inside</button>
    </BoardModalFrame>,
  );

  const dialog = screen.getByRole("dialog", { name: "Test Board Dialog" });
  expect(dialog).toBeVisible();
  expect(screen.getByTestId("test-backdrop")).toBeVisible();
  expect(screen.getByTestId("test-panel")).toHaveClass("border");
  expect(dialog.parentElement).toHaveClass("w-[460px]", "max-w-[94vw]");
});

it("dismisses through the overlay open-state callback", async () => {
  const onClose = vi.fn();

  render(
    <BoardModalFrame
      ariaLabel="Test Board Dialog"
      widthClassName="w-[460px]"
      backdropTestId="test-backdrop"
      modalTestId="test-panel"
      onClose={onClose}
    >
      <button type="button">Inside</button>
    </BoardModalFrame>,
  );

  await userEvent.click(screen.getByTestId("test-backdrop"));

  expect(onClose).toHaveBeenCalledOnce();
});

it("forwards keyboard events from modal content", async () => {
  const onKeyDown = vi.fn();

  render(
    <BoardModalFrame
      ariaLabel="Test Board Dialog"
      widthClassName="w-[460px]"
      backdropTestId="test-backdrop"
      modalTestId="test-panel"
      onClose={vi.fn()}
      onKeyDown={onKeyDown}
    >
      <button type="button">Inside</button>
    </BoardModalFrame>,
  );

  await userEvent.click(screen.getByRole("button", { name: "Inside" }));
  await userEvent.keyboard("{Enter}");

  expect(onKeyDown).toHaveBeenCalled();
});
