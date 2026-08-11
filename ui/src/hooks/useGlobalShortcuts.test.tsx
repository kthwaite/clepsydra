import { renderHook } from "@testing-library/react";
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
});
