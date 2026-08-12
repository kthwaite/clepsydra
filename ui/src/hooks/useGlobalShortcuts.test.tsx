import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { navigateMock, openTabMock, toggleThemeMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  openTabMock: vi.fn(),
  toggleThemeMock: vi.fn(),
}));

// IS_MAC is computed when #/lib/shortcuts first loads, so the platform must
// be stubbed before any import. This file exercises the Mac chords (⌘K etc.).
vi.hoisted(() => {
  Object.defineProperty(navigator, "platform", {
    value: "MacIntel",
    configurable: true,
  });
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));
vi.mock("#/components/ThemeProvider", () => ({
  useTheme: () => ({ toggle: toggleThemeMock }),
}));
vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
}));
vi.mock("#/api/journal", () => ({
  useJournalToday: () => ({ data: null, refetch: vi.fn() }),
}));

import { useGlobalShortcuts } from "#/hooks/useGlobalShortcuts";
import { todayJournalPath } from "#/lib/journal";
import { useBoardStore } from "#/store/board";
import { useUiStore } from "#/store/ui";
import { useWorkspaceStore } from "#/store/workspace";

function press(
  key: string,
  mods: Partial<{
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  }> = {},
  { prevented = false } = {},
) {
  const e = new KeyboardEvent("keydown", {
    key,
    cancelable: true,
    bubbles: true,
    ...mods,
  });
  if (prevented) e.preventDefault();
  window.dispatchEvent(e);
  return e;
}

/** Like press(), but dispatches on a specific element so e.target reflects
 *  where focus actually is (needed to exercise the editable-target guard). */
function pressOn(
  target: Element,
  key: string,
  mods: Partial<{
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  }> = {},
) {
  const e = new KeyboardEvent("keydown", {
    key,
    cancelable: true,
    bubbles: true,
    ...mods,
  });
  target.dispatchEvent(e);
  return e;
}

describe("useGlobalShortcuts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState({
      isSearchOpen: false,
      isInscribeOpen: false,
      isCaptureAsideOpen: false,
      isShortcutHelpOpen: false,
      isSettingsOpen: false,
    });
    useWorkspaceStore.setState({ tabs: [], activeTabId: null });
    useBoardStore.setState({
      mode: "card",
      railOpen: true,
      taskModal: null,
    });
    window.history.pushState({}, "", "/");
  });

  it("⌘K toggles the command palette; Ctrl+K is left to the system", () => {
    renderHook(() => useGlobalShortcuts());
    press("k", { metaKey: true });
    expect(useUiStore.getState().isSearchOpen).toBe(true);
    press("k", { ctrlKey: true });
    expect(useUiStore.getState().isSearchOpen).toBe(true);
    press("k", { metaKey: true });
    expect(useUiStore.getState().isSearchOpen).toBe(false);
  });

  it("⌘N opens inscribe and ⌘/ opens shortcut help", () => {
    renderHook(() => useGlobalShortcuts());
    press("n", { metaKey: true });
    expect(useUiStore.getState().isInscribeOpen).toBe(true);
    press("/", { metaKey: true });
    expect(useUiStore.getState().isShortcutHelpOpen).toBe(true);
  });

  it("binds the previously-phantom navigation chords", () => {
    renderHook(() => useGlobalShortcuts());
    press("h", { metaKey: true });
    expect(navigateMock).toHaveBeenCalledWith({ to: "/" });
    press("d", { metaKey: true });
    expect(openTabMock).toHaveBeenCalledWith(
      "page",
      todayJournalPath(),
      expect.any(String),
    );
    press("d", { metaKey: true, shiftKey: true });
    expect(useUiStore.getState().isCaptureAsideOpen).toBe(true);
    press("i", { metaKey: true });
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/gazetteer",
      search: { sort: "ts", page: 1 },
    });
    press("g", { metaKey: true });
    expect(openTabMock).toHaveBeenCalledWith("graph");
    press("\\", { metaKey: true });
    expect(toggleThemeMock).toHaveBeenCalled();
  });

  it("⌘, opens settings at appearance", () => {
    renderHook(() => useGlobalShortcuts());
    press(",", { metaKey: true });
    const s = useUiStore.getState();
    expect(s.isSettingsOpen).toBe(true);
    expect(s.activeSettingsSection).toBe("appearance");
  });

  it("yields to already-handled events (editor conflict policy)", () => {
    renderHook(() => useGlobalShortcuts());
    press("d", { metaKey: true }, { prevented: true });
    expect(openTabMock).not.toHaveBeenCalled();
  });

  it("cycles and closes tabs only in the workspace view", () => {
    renderHook(() => useGlobalShortcuts());
    useWorkspaceStore.setState({
      tabs: [
        { id: "a", type: "page", label: "A" },
        { id: "b", type: "page", label: "B" },
        { id: "c", type: "page", label: "C" },
      ],
      activeTabId: "a",
    });

    // outside /workspace: ignored, not even preventDefault
    const ignored = press("Tab", { ctrlKey: true });
    expect(ignored.defaultPrevented).toBe(false);
    expect(useWorkspaceStore.getState().activeTabId).toBe("a");

    window.history.pushState({}, "", "/workspace");
    press("Tab", { ctrlKey: true });
    expect(useWorkspaceStore.getState().activeTabId).toBe("b");
    press("Tab", { ctrlKey: true, shiftKey: true });
    expect(useWorkspaceStore.getState().activeTabId).toBe("a");
    // wrap-around backwards
    press("Tab", { ctrlKey: true, shiftKey: true });
    expect(useWorkspaceStore.getState().activeTabId).toBe("c");

    press("w", { metaKey: true });
    expect(
      useWorkspaceStore.getState().tabs.find((t) => t.id === "c"),
    ).toBeUndefined();
  });

  it("removes its listener on unmount", () => {
    const { unmount } = renderHook(() => useGlobalShortcuts());
    unmount();
    press("k", { metaKey: true });
    expect(useUiStore.getState().isSearchOpen).toBe(false);
  });

  describe("tasking shortcuts", () => {
    it("N on /tasking opens the task modal", () => {
      window.history.pushState({}, "", "/tasking");
      renderHook(() => useGlobalShortcuts());
      press("n");
      expect(useBoardStore.getState().taskModal).toEqual({});
    });

    it("tasking chords fall through (no preventDefault) outside /tasking", () => {
      renderHook(() => useGlobalShortcuts());
      // outside /tasking: every gated chord is ignored, not even
      // preventDefault — mirrors the workspace-tabs off-route assertion above.
      for (const key of ["n", "1", "2", "3", "4", "/", "["]) {
        const ignored = press(key);
        expect(ignored.defaultPrevented).toBe(false);
      }
      expect(useBoardStore.getState().taskModal).toBeNull();
      expect(useBoardStore.getState().mode).toBe("card");
      expect(useBoardStore.getState().railOpen).toBe(true);
    });

    it("2 switches to backlog mode", () => {
      window.history.pushState({}, "", "/tasking");
      renderHook(() => useGlobalShortcuts());
      press("2");
      expect(useBoardStore.getState().mode).toBe("backlog");
    });

    it("1, 3, 4 switch to card, cycle, and timeline modes", () => {
      window.history.pushState({}, "", "/tasking");
      renderHook(() => useGlobalShortcuts());
      press("3");
      expect(useBoardStore.getState().mode).toBe("cycle");
      press("4");
      expect(useBoardStore.getState().mode).toBe("timeline");
      press("1");
      expect(useBoardStore.getState().mode).toBe("card");
    });

    it("[ toggles the rail", () => {
      window.history.pushState({}, "", "/tasking");
      renderHook(() => useGlobalShortcuts());
      expect(useBoardStore.getState().railOpen).toBe(true);
      press("[");
      expect(useBoardStore.getState().railOpen).toBe(false);
      press("[");
      expect(useBoardStore.getState().railOpen).toBe(true);
    });

    it("/ focuses the tasking filter input", () => {
      window.history.pushState({}, "", "/tasking");
      const input = document.createElement("input");
      input.id = "tasking-filter";
      document.body.appendChild(input);
      try {
        renderHook(() => useGlobalShortcuts());
        press("/");
        expect(document.activeElement).toBe(input);
      } finally {
        document.body.removeChild(input);
      }
    });

    it("bare keys do nothing when typing in an input", () => {
      window.history.pushState({}, "", "/tasking");
      const input = document.createElement("input");
      document.body.appendChild(input);
      try {
        renderHook(() => useGlobalShortcuts());
        pressOn(input, "2");
        expect(useBoardStore.getState().mode).toBe("card");
      } finally {
        document.body.removeChild(input);
      }
    });

    it("bare-key shortcuts still fire when focus is on a non-editable button", () => {
      window.history.pushState({}, "", "/tasking");
      const button = document.createElement("button");
      document.body.appendChild(button);
      try {
        renderHook(() => useGlobalShortcuts());
        pressOn(button, "2");
        expect(useBoardStore.getState().mode).toBe("backlog");
      } finally {
        document.body.removeChild(button);
      }
    });

    it("no global shortcut fires while a dialog is open", () => {
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      document.body.appendChild(dialog);
      try {
        renderHook(() => useGlobalShortcuts());
        press("n", { metaKey: true });
        expect(useUiStore.getState().isInscribeOpen).toBe(false);
      } finally {
        document.body.removeChild(dialog);
      }
    });

    it("⌘K is exempt from the open-dialog guard (can still close the palette it opened), unlike other shortcuts", () => {
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      document.body.appendChild(dialog);
      try {
        renderHook(() => useGlobalShortcuts());

        act(() => {
          press("k", { metaKey: true });
        });
        expect(useUiStore.getState().isSearchOpen).toBe(true);

        // A non-exempt shortcut still does NOT fire while the dialog is open.
        act(() => {
          press("h", { metaKey: true });
        });
        expect(navigateMock).not.toHaveBeenCalled();
      } finally {
        document.body.removeChild(dialog);
      }
    });
  });
});
