import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ShortcutHelpModal } from "#/components/codex/ShortcutHelpModal";
import { SHORTCUTS } from "#/lib/shortcuts";
import { useUiStore } from "#/store/ui";

describe("ShortcutHelpModal", () => {
  beforeEach(() => {
    useUiStore.setState({ isShortcutHelpOpen: true });
  });

  it("renders nothing when closed", () => {
    useUiStore.setState({ isShortcutHelpOpen: false });
    render(<ShortcutHelpModal />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lists every registry entry exactly once, under group headers", () => {
    render(<ShortcutHelpModal />);
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(dialog).toBeInTheDocument();

    for (const def of Object.values(SHORTCUTS)) {
      expect(screen.getAllByText(def.label).length).toBeGreaterThanOrEqual(1);
    }
    // one row (and one <kbd>) per registry entry
    expect(dialog.querySelectorAll("kbd").length).toBe(
      Object.keys(SHORTCUTS).length,
    );
    for (const group of ["NAVIGATE", "WORKSPACE", "EDITOR"]) {
      expect(screen.getByText(group)).toBeInTheDocument();
    }
  });

  it("shows notes where defined", () => {
    render(<ShortcutHelpModal />);
    expect(screen.getAllByText("outside the editor").length).toBe(3);
  });

  it("ignores Escape already consumed by another handler", () => {
    render(<ShortcutHelpModal />);
    const e = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
      bubbles: true,
    });
    e.preventDefault();
    window.dispatchEvent(e);
    expect(useUiStore.getState().isShortcutHelpOpen).toBe(true);
  });

  it("closes on Escape", async () => {
    render(<ShortcutHelpModal />);
    await userEvent.keyboard("{Escape}");
    expect(useUiStore.getState().isShortcutHelpOpen).toBe(false);
  });
});
