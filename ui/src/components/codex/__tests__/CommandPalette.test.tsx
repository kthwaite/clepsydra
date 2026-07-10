import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));
vi.mock("#/api/index", () => ({
  useSearch: () => ({ data: [] }),
  useTags: () => ({ data: [] }),
}));
vi.mock("#/components/ThemeProvider", () => ({
  useTheme: () => ({
    toggle: vi.fn(),
    diegetic: false,
    setDiegetic: vi.fn(),
  }),
}));
vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => vi.fn(),
}));
vi.mock("#/store/workspace", () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) =>
    selector({ tabs: [], quires: {}, activeTabId: null }),
}));

import { CommandPalette } from "#/components/codex/CommandPalette";
import { useUiStore } from "#/store/ui";

describe("CommandPalette keyboard navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState({ isSearchOpen: true });
  });

  it("moves down and dispatches the selected command with Enter", async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);

    await user.click(screen.getByRole("textbox"));
    await user.keyboard("{ArrowDown}{Enter}");

    expect(navigateMock).toHaveBeenCalledWith({ to: "/journal" });
    expect(useUiStore.getState().isSearchOpen).toBe(false);
  });

  it("closes on Escape without dispatching a command", async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);

    await user.click(screen.getByRole("textbox"));
    await user.keyboard("{Escape}");

    expect(navigateMock).not.toHaveBeenCalled();
    expect(useUiStore.getState().isSearchOpen).toBe(false);
  });
});
