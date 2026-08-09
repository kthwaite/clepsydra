import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler } from "react";
import { flushSync } from "react-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { navigateMock, openTabMock, useSearchMock, useTagsMock } = vi.hoisted(
  () => ({
    navigateMock: vi.fn(),
    openTabMock: vi.fn(),
    useSearchMock: vi.fn(() => ({ data: [] })),
    useTagsMock: vi.fn(() => ({ data: [] })),
  }),
);

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));
vi.mock("#/api/journal", () => ({
  useJournalToday: () => ({ data: null, refetch: vi.fn() }),
}));
vi.mock("#/api/index", () => ({
  useSearch: useSearchMock,
  useTags: useTagsMock,
}));
vi.mock("#/components/ThemeProvider", () => ({
  useTheme: () => ({
    toggle: vi.fn(),
    diegetic: false,
    setDiegetic: vi.fn(),
  }),
}));
vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
}));
vi.mock("#/store/workspace", () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) =>
    selector({ tabs: [], quires: {}, activeTabId: null }),
}));

import { CommandPalette } from "#/components/codex/CommandPalette";
import { todayJournalPath } from "#/lib/journal";
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

    expect(openTabMock).toHaveBeenCalledWith(
      "page",
      todayJournalPath(),
      expect.any(String),
    );
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

  it("lists Today's journal and not Open Diurnal", () => {
    render(<CommandPalette />);

    expect(screen.getByText("Today's journal")).toBeInTheDocument();
    expect(screen.queryByText("Open Diurnal")).not.toBeInTheDocument();
  });

  it("resets the selected command as soon as typing changes the query", async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);
    const input = screen.getByRole("textbox");

    await user.click(input);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    await user.type(input, "today");
    await user.keyboard("{Enter}");

    expect(openTabMock).toHaveBeenCalledWith(
      "page",
      todayJournalPath(),
      expect.any(String),
    );
  });

  it("does not subscribe to search or tags while closed", () => {
    useUiStore.setState({ isSearchOpen: false });

    render(<CommandPalette />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useSearchMock).not.toHaveBeenCalled();
    expect(useTagsMock).not.toHaveBeenCalled();
  });

  it("resets selection in the same commit as a query change", () => {
    const commits: string[] = [];
    render(
      <Profiler id="palette" onRender={() => commits.push("commit")}>
        <CommandPalette />
      </Profiler>,
    );
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    commits.length = 0;

    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    flushSync(() => {
      setValue?.call(input, "open");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(commits).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Open Atrium/ })).toHaveClass(
      "bg-ink",
    );
  });

  it("opens the Bases index with the keyboard", async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);

    const query = screen.getByRole("textbox", { name: "Command query" });
    await user.type(query, "Open Bases{Enter}");

    expect(navigateMock).toHaveBeenCalledWith({ to: "/bases" });
    expect(useUiStore.getState().isSearchOpen).toBe(false);
  });

  it("opens guided Base creation with the keyboard", async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);

    const query = screen.getByRole("textbox", { name: "Command query" });
    await user.type(query, "Create Base{Enter}");

    expect(navigateMock).toHaveBeenCalledWith({
      to: "/bases",
      search: { create: true },
    });
    expect(useUiStore.getState().isSearchOpen).toBe(false);
  });
});
