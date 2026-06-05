import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "#/store/workspace";
import { FolioBoundary } from "../FolioBoundary";

function Boom(): never {
  throw new Error("boom");
}

describe("FolioBoundary", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      tabs: [{ id: "t1", type: "page", path: "notes/gone.md", label: "gone" }],
      activeTabId: "t1",
    });
  });

  it("renders the recovery panel when a child throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <FolioBoundary path="notes/gone.md">
        <Boom />
      </FolioBoundary>,
    );
    expect(screen.getByText("Folio not found.")).toBeInTheDocument();
    spy.mockRestore();
  });

  it("closes the active tab from the recovery panel", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    render(
      <FolioBoundary path="notes/gone.md">
        <Boom />
      </FolioBoundary>,
    );
    await user.click(screen.getByRole("button", { name: /close tab/i }));
    expect(useWorkspaceStore.getState().tabs).toHaveLength(0);
    spy.mockRestore();
  });
});
