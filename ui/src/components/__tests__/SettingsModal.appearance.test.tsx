import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsModal } from "#/components/SettingsModal";

const mocks = vi.hoisted(() => ({
  closeSettings: vi.fn(),
  setAccent: vi.fn(),
  setActiveSettingsSection: vi.fn(),
  setDensity: vi.fn(),
  setDiegetic: vi.fn(),
  setMode: vi.fn(),
}));

vi.mock("#/api/encryption", () => ({
  useEncryptionConfig: () => ({ data: { initialized: false } }),
}));

vi.mock("#/api/index", () => ({
  useStats: () => ({ data: undefined }),
}));

vi.mock("#/api/location", () => ({
  useLocation: () => ({ data: undefined }),
}));

vi.mock("#/components/ThemeProvider", () => ({
  useTheme: () => ({
    resolvedTheme: "dark",
    setMode: mocks.setMode,
    accent: "barbican",
    setAccent: mocks.setAccent,
    density: "default",
    setDensity: mocks.setDensity,
    diegetic: true,
    setDiegetic: mocks.setDiegetic,
  }),
}));

vi.mock("#/store/ui", () => ({
  useUiStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      isSettingsOpen: true,
      activeSettingsSection: "appearance",
      closeSettings: mocks.closeSettings,
      setActiveSettingsSection: mocks.setActiveSettingsSection,
    }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SettingsModal appearance", () => {
  it("routes mode, density, and accent radio choices to theme callbacks", async () => {
    const user = userEvent.setup();
    render(<SettingsModal />);

    expect(screen.getByRole("radiogroup", { name: "Mode" })).toBeVisible();
    expect(screen.getByRole("radiogroup", { name: "Accent" })).toBeVisible();
    expect(screen.getByRole("radiogroup", { name: "Density" })).toBeVisible();

    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Barbican/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Default/i })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "Paper" }));
    expect(mocks.setMode).toHaveBeenCalledWith("light");

    await user.click(screen.getByRole("radio", { name: /Compact/i }));
    expect(mocks.setDensity).toHaveBeenCalledWith("compact");

    await user.click(screen.getByRole("radio", { name: /Alert/i }));
    expect(mocks.setAccent).toHaveBeenCalledWith("alert");
  });
});
