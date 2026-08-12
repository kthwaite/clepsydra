import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsModal } from "#/components/SettingsModal";
import { IndexHealthPanel } from "#/components/settings/IndexHealthPanel";

const mocks = vi.hoisted(() => ({
  closeSettings: vi.fn(),
  navigate: vi.fn(),
  rebuildIndex: vi.fn(),
  setActiveSettingsSection: vi.fn(),
  warningsState: {
    data: ["Failed to parse broken.md"] as string[] | undefined,
    error: null as unknown,
    isPending: false,
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("#/api/index", () => ({
  useIndexWarnings: () => mocks.warningsState,
  useRebuildIndex: () => ({
    mutateAsync: mocks.rebuildIndex,
    isPending: false,
  }),
  useStats: () => ({ data: undefined }),
}));

vi.mock("#/api/encryption", () => ({
  useEncryptionConfig: () => ({ data: { initialized: false } }),
}));

vi.mock("#/api/location", () => ({
  useLocation: () => ({ data: undefined }),
}));

vi.mock("#/components/ThemeProvider", () => ({
  useTheme: vi.fn(),
}));

vi.mock("#/store/ui", () => ({
  useUiStore: (selector: (state: unknown) => unknown) =>
    selector({
      isSettingsOpen: true,
      activeSettingsSection: "advanced",
      closeSettings: mocks.closeSettings,
      setActiveSettingsSection: mocks.setActiveSettingsSection,
    }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.warningsState.data = ["Failed to parse broken.md"];
  mocks.warningsState.error = null;
  mocks.warningsState.isPending = false;

  mocks.rebuildIndex.mockResolvedValue({
    pages_indexed: 12,
    pages_skipped: 1,
    pages_removed: 2,
    warnings: ["Skipped malformed.md"],
  });
});

describe("IndexHealthPanel", () => {
  it("opens the reference repair workspace and closes settings", async () => {
    const user = userEvent.setup();
    render(<IndexHealthPanel />);

    await user.click(
      screen.getByRole("button", { name: "Open Reference Repairs" }),
    );

    expect(mocks.closeSettings).toHaveBeenCalledOnce();
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/repairs" });
  });

  it("keeps warnings and rebuild while retiring duplicate repair controls", () => {
    render(<IndexHealthPanel />);

    expect(
      screen.getByRole("heading", { name: "Index diagnostics" }),
    ).toBeVisible();
    expect(screen.getByText("Failed to parse broken.md")).toBeVisible();
    expect(screen.getByRole("button", { name: "Rebuild index" })).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Unresolved links" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Create page/ }),
    ).not.toBeInTheDocument();
  });

  it("requires typed confirmation before rebuilding and reports the result", async () => {
    const user = userEvent.setup();
    render(<IndexHealthPanel />);

    await user.click(screen.getByRole("button", { name: "Rebuild index" }));
    const dialog = screen.getByRole("dialog", { name: "Rebuild vault index" });
    const rebuild = within(dialog).getByRole("button", {
      name: "Rebuild now",
    });
    expect(rebuild).toBeDisabled();
    expect(mocks.rebuildIndex).not.toHaveBeenCalled();

    await user.type(
      within(dialog).getByRole("textbox", {
        name: "Type REBUILD to confirm",
      }),
      "REBUILD",
    );
    await user.click(rebuild);

    expect(mocks.rebuildIndex).toHaveBeenCalledWith({});
    expect(
      await screen.findByText(
        "Indexed 12 pages, skipped 1, removed 2. 1 warning.",
      ),
    ).toBeVisible();
  });
});

describe("SettingsModal integration", () => {
  it("replaces the advanced diagnostics and data placeholders", () => {
    render(<SettingsModal />);

    expect(
      screen.getByRole("heading", { name: "Index diagnostics" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Index maintenance" }),
    ).toBeVisible();
    expect(
      screen.queryByText(
        "Performance and debugging controls will be available here.",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "Import/export and maintenance actions are planned for this section.",
      ),
    ).not.toBeInTheDocument();
  });
});
