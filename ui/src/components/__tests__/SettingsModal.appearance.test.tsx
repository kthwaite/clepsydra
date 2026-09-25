import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsModal } from "#/components/SettingsModal";

const mocks = vi.hoisted(() => ({
  closeSettings: vi.fn(),
  setActiveSettingsSection: vi.fn(),
  setDensity: vi.fn(),
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
    density: "default",
    setDensity: mocks.setDensity,
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
  it("routes mode and density choices to theme callbacks, with no accent picker", async () => {
    const user = userEvent.setup();
    render(<SettingsModal />);

    expect(screen.getByRole("radiogroup", { name: "Mode" })).toBeVisible();
    expect(screen.getByRole("radiogroup", { name: "Density" })).toBeVisible();
    expect(screen.queryByRole("radiogroup", { name: "Accent" })).toBeNull();

    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Default/i })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "Paper" }));
    expect(mocks.setMode).toHaveBeenCalledWith("light");

    await user.click(screen.getByRole("radio", { name: /Compact/i }));
    expect(mocks.setDensity).toHaveBeenCalledWith("compact");
  });

  it("has no diegetic chrome control", () => {
    render(<SettingsModal />);
    expect(screen.queryByText(/diegetic/i)).toBeNull();
  });
});
