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

    expect(screen.getByRole("radio", { name: "Night" })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Default/i })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "Bone" }));
    expect(mocks.setMode).toHaveBeenCalledWith("light");

    await user.click(screen.getByRole("radio", { name: /Compact/i }));
    expect(mocks.setDensity).toHaveBeenCalledWith("compact");
  });

  it("labels the modes Bone and Night, with the theme shortcut hint", () => {
    render(<SettingsModal />);
    expect(screen.queryByRole("radio", { name: "Dark" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Paper" })).toBeNull();
    expect(
      screen.getByText(/Bone for daylight, night for the lamp\./),
    ).toBeVisible();
    const kbd = screen.getByText("⇧⌘\\");
    expect(kbd.tagName).toBe("KBD");
    expect(
      screen.getByText(
        "Sets row height and spacing, not type size. Each table's Compact switch starts from here.",
      ),
    ).toBeVisible();
  });

  it("previews the selected density with hidden sample rows", () => {
    const { container } = render(<SettingsModal />);
    const preview = container.ownerDocument.querySelector(
      "[data-density-preview]",
    );
    expect(preview).not.toBeNull();
    expect(preview).toHaveAttribute("aria-hidden", "true");
    expect(preview?.getAttribute("data-density-preview")).toBe("default");
  });

  it("names the section in a serif title and marks the current nav item", () => {
    render(<SettingsModal />);
    expect(screen.getByRole("heading", { name: "Settings" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeVisible();
    expect(screen.getByText("How the app looks on this device.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Appearance" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByRole("button", { name: "General" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(screen.getByText(/Stored in this browser\./)).toBeVisible();
  });

  it("has no diegetic chrome control", () => {
    render(<SettingsModal />);
    expect(screen.queryByText(/diegetic/i)).toBeNull();
  });
});
