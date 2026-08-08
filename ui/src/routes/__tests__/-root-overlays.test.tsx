import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useUiStore } from "#/store/ui";
import { usePreviewStore } from "#/store/preview";

vi.mock("#/components/codex/CommandPalette", () => ({
  CommandPalette: () => <div>lazy command palette</div>,
}));
vi.mock("#/components/SettingsModal", () => ({
  SettingsModal: () => <div>lazy settings</div>,
}));
vi.mock("#/components/codex/InscribeModal", () => ({
  InscribeModal: () => <div>lazy inscribe</div>,
}));
vi.mock("#/components/codex/CaptureAsideModal", () => ({
  CaptureAsideModal: () => <div>lazy capture</div>,
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

import { GlobalOverlays } from "#/routes/__root";

beforeEach(() => {
  useUiStore.setState({
    isSearchOpen: false,
    isSettingsOpen: false,
    isInscribeOpen: false,
    isCaptureAsideOpen: false,
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
