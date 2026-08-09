import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { usePreviewStore } from "#/store/preview";
import { useUiStore } from "#/store/ui";

vi.mock("#/components/codex/CommandPalette", () => ({
  CommandPalette: () => (
    <div role="dialog" aria-label="Command console">
      lazy command palette
    </div>
  ),
}));
vi.mock("#/components/SettingsModal", () => ({
  SettingsModal: () => (
    <div role="dialog" aria-label="Settings">
      lazy settings
    </div>
  ),
}));
vi.mock("#/components/codex/InscribeModal", () => ({
  InscribeModal: () => (
    <div role="dialog" aria-label="Intake">
      lazy inscribe
    </div>
  ),
}));
vi.mock("#/components/codex/CaptureAsideModal", () => ({
  CaptureAsideModal: () => <div>lazy capture</div>,
}));
vi.mock("#/components/books/BookImportModal", () => ({
  BookImportModal: () => (
    <div role="dialog" aria-label="Add book">
      lazy book import
    </div>
  ),
}));
vi.mock("#/components/codex/LocationModal", () => ({
  LocationModal: () => <div>lazy location</div>,
}));
vi.mock("#/components/codex/ShortcutHelpModal", () => ({
  ShortcutHelpModal: () => <div>lazy shortcut help</div>,
}));
vi.mock("#/components/codex/BootSequence", () => ({
  BootSequence: () => <div>lazy boot</div>,
}));
vi.mock("#/components/codex/LinkPreviewLayer", () => ({
  LinkPreviewLayer: () => <div>lazy previews</div>,
}));

import { GlobalOverlays, OverlayBoundary } from "#/routes/__root";

beforeEach(() => {
  useUiStore.setState({
    isSearchOpen: false,
    isSettingsOpen: false,
    isInscribeOpen: false,
    isCaptureAsideOpen: false,
    isBookImportOpen: false,
    isLocationOpen: false,
    isShortcutHelpOpen: false,
    isBooting: false,
  });
  usePreviewStore.setState({ windows: [] });
});

it("mounts infrequent overlays only while their state is active", async () => {
  render(<GlobalOverlays />);
  expect(screen.queryByText(/^lazy /)).not.toBeInTheDocument();

  act(() => useUiStore.setState({ isSearchOpen: true }));
  expect(await screen.findByText("lazy command palette")).toBeInTheDocument();
  expect(screen.queryByText("lazy settings")).not.toBeInTheDocument();
});

it("opens Search, Settings, and New note as named dialogs through store actions", async () => {
  render(<GlobalOverlays />);
  const cases = [
    ["Command console", () => useUiStore.getState().openSearch()],
    ["Settings", () => useUiStore.getState().openSettings()],
    ["Intake", () => useUiStore.getState().openInscribe()],
    ["Add book", () => useUiStore.getState().openBookImport()],
  ] as const;

  for (const [name, open] of cases) {
    act(open);
    expect(await screen.findByRole("dialog", { name })).toBeInTheDocument();
    act(() => {
      useUiStore.setState({
        isSearchOpen: false,
        isSettingsOpen: false,
        isInscribeOpen: false,
        isBookImportOpen: false,
      });
    });
  }
});

it("mounts each overlay from its corresponding UI state", async () => {
  render(<GlobalOverlays />);
  const cases = [
    ["isSettingsOpen", "lazy settings"],
    ["isInscribeOpen", "lazy inscribe"],
    ["isCaptureAsideOpen", "lazy capture"],
    ["isBookImportOpen", "lazy book import"],
    ["isLocationOpen", "lazy location"],
    ["isShortcutHelpOpen", "lazy shortcut help"],
    ["isBooting", "lazy boot"],
  ] as const;

  for (const [state, label] of cases) {
    act(() => useUiStore.setState({ [state]: true }));
    expect(await screen.findByText(label)).toBeInTheDocument();
    act(() => useUiStore.setState({ [state]: false }));
    expect(screen.queryByText(label)).not.toBeInTheDocument();
  }

  act(() =>
    usePreviewStore.setState({
      windows: [
        {
          id: "preview-test",
          path: "notes/test.md",
          x: 0,
          y: 0,
          pinned: false,
          minimized: false,
          z: 1,
        },
      ],
    }),
  );
  expect(screen.getByText("lazy previews")).toBeInTheDocument();
});

it("keeps a pending overlay dismissible while it loads", () => {
  const onDismiss = vi.fn();
  const pending = new Promise<never>(() => {});
  function PendingOverlay(): never {
    throw pending;
  }

  render(
    <OverlayBoundary onDismiss={onDismiss} label="search">
      <PendingOverlay />
    </OverlayBoundary>,
  );

  const fallback = screen.getByRole("dialog", { name: "Loading search" });
  expect(fallback).toHaveAttribute("aria-modal", "true");
  expect(fallback).toHaveAttribute("tabindex", "-1");
  fireEvent.keyDown(fallback, { key: "Escape" });
  expect(onDismiss).toHaveBeenCalledOnce();
});
