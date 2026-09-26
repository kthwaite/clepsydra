import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ShortcutHelpModal } from "#/components/codex/ShortcutHelpModal";
import { IS_MAC, SHORTCUTS } from "#/lib/shortcuts";
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
    // one row (one <dd> of key chips) per registry entry
    const keyCells = dialog.querySelectorAll("dd");
    expect(keyCells.length).toBe(Object.keys(SHORTCUTS).length);
    for (const cell of keyCells) {
      expect(cell.querySelectorAll("kbd").length).toBeGreaterThanOrEqual(1);
    }
    for (const group of ["Navigate", "Workspace", "Editor", "Tasking"]) {
      expect(
        screen.getByRole("heading", { level: 3, name: group }),
      ).toBeInTheDocument();
    }
  });

  it("titles the sheet and hints Esc to close", () => {
    render(<ShortcutHelpModal />);
    expect(
      screen.getByRole("heading", { level: 2, name: "Keyboard shortcuts" }),
    ).toBeInTheDocument();
    const esc = screen.getByText("Esc", { selector: "kbd" });
    expect(esc.parentElement).toHaveTextContent(/^Esc to close$/);
  });

  it("splits each chord into one key chip per key", () => {
    render(<ShortcutHelpModal />);
    const def = SHORTCUTS["app.shortcutHelp"];
    const row = screen.getByText(def.label, { selector: "dt" }).parentElement;
    if (!row) throw new Error("Expected a shortcut row");
    const chips = [...row.querySelectorAll("dd kbd")].map((k) => k.textContent);
    expect(chips).toEqual(IS_MAC ? ["⌘", "/"] : ["Ctrl", "/"]);
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
