import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BottomSheet } from "#/components/ui/sheet";

describe("BottomSheet", () => {
  it("renders a labelled dialog when open", () => {
    render(
      <BottomSheet isOpen onOpenChange={() => {}} aria-label="Open pages">
        <p>Body</p>
      </BottomSheet>,
    );
    expect(
      screen.getByRole("dialog", { name: "Open pages" }),
    ).toHaveTextContent("Body");
  });

  it("renders nothing when closed", () => {
    render(
      <BottomSheet isOpen={false} onOpenChange={() => {}} aria-label="X">
        <p>Body</p>
      </BottomSheet>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const onOpenChange = vi.fn();
    render(
      <BottomSheet isOpen onOpenChange={onOpenChange} aria-label="X">
        <button type="button">In</button>
      </BottomSheet>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
