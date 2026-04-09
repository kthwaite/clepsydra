import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "#/components/ui/dialog";

describe("Dialog", () => {
  it("renders title when open", () => {
    render(
      <Dialog isOpen onOpenChange={() => {}} title="Create Note">
        <p>Body</p>
      </Dialog>,
    );
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByText("Create Note")).toBeDefined();
  });

  it("renders description", () => {
    render(
      <Dialog
        isOpen
        onOpenChange={() => {}}
        title="Test"
        description="A description"
      >
        <p>Body</p>
      </Dialog>,
    );
    expect(screen.getByText("A description")).toBeDefined();
  });

  it("renders children in body", () => {
    render(
      <Dialog isOpen onOpenChange={() => {}} title="Test">
        <p>Hello body</p>
      </Dialog>,
    );
    expect(screen.getByText("Hello body")).toBeDefined();
  });

  it("renders footer", () => {
    render(
      <Dialog
        isOpen
        onOpenChange={() => {}}
        title="Test"
        footer={<button type="button">Save</button>}
      >
        <p>Body</p>
      </Dialog>,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
  });

  it("calls onOpenChange(false) when Escape is pressed", async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(
      <Dialog isOpen onOpenChange={handler} title="Test">
        <p>Body</p>
      </Dialog>,
    );
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(handler).toHaveBeenCalledWith(false);
    });
  });

  it("does not render when isOpen is false", () => {
    render(
      <Dialog isOpen={false} onOpenChange={() => {}} title="Test">
        <p>Body</p>
      </Dialog>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
