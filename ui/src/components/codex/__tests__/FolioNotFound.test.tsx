import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FolioNotFound } from "../FolioNotFound";

describe("FolioNotFound", () => {
  it("shows the missing path and a not-found message", () => {
    render(<FolioNotFound path="notes/gone.md" onClose={() => {}} />);
    expect(screen.getByText("notes/gone.md")).toBeInTheDocument();
    expect(screen.getByText("Folio not found.")).toBeInTheDocument();
  });

  it("invokes onClose when Close tab is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<FolioNotFound path="notes/gone.md" onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: /close tab/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
