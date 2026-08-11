import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler } from "react";
import { flushSync } from "react-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  navigateMock,
  openTabMock,
  searchRefetchMock,
  useSearchMock,
  useTagsMock,
} = vi.hoisted(() => {
  const searchRefetchMock = vi.fn();
  return {
    navigateMock: vi.fn(),
    openTabMock: vi.fn(),
    searchRefetchMock,
    useSearchMock: vi.fn((_query: string, _limit?: number) => ({
      data: [] as unknown[] | undefined,
      isFetching: false,
      isError: false,
      error: null as Error | null,
      refetch: searchRefetchMock,
    })),
    useTagsMock: vi.fn(() => ({ data: [] })),
  };
});

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
    useSearchMock.mockReturnValue({
      data: [],
      isFetching: false,
      isError: false,
      error: null,
      refetch: searchRefetchMock,
    });
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

  it("opens book import with the keyboard", async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);

    const query = screen.getByRole("textbox", { name: "Command query" });
    await user.type(query, "Add book by ISBN{Enter}");

    expect(useUiStore.getState().isSearchOpen).toBe(false);
    expect(useUiStore.getState().isBookImportOpen).toBe(true);
  });

  it("opens the Academic library with the keyboard", async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);

    const query = screen.getByRole("textbox", { name: "Command query" });
    await user.type(query, "Open Academic Library{Enter}");

    expect(navigateMock).toHaveBeenCalledWith({ to: "/academic" });
    expect(useUiStore.getState().isSearchOpen).toBe(false);
  });

  it("announces while vault search results are loading", async () => {
    useSearchMock.mockImplementation((query: string) => ({
      data: undefined,
      isFetching: query === "clep",
      isError: false,
      error: null,
      refetch: searchRefetchMock,
    }));
    const user = userEvent.setup();
    render(<CommandPalette />);

    await user.type(
      screen.getByRole("textbox", { name: "Command query" }),
      "clep",
    );
    await waitFor(() =>
      expect(useSearchMock).toHaveBeenLastCalledWith("clep", 12),
    );

    expect(screen.getByRole("status")).toHaveTextContent(/searching/i);
  });

  it("announces the backend search error", async () => {
    useSearchMock.mockImplementation((query: string) => ({
      data: undefined,
      isFetching: false,
      isError: query === "clep",
      error:
        query === "clep" ? new Error("Search service unavailable") : null,
      refetch: searchRefetchMock,
    }));
    const user = userEvent.setup();
    render(<CommandPalette />);

    await user.type(
      screen.getByRole("textbox", { name: "Command query" }),
      "clep",
    );
    await waitFor(() =>
      expect(useSearchMock).toHaveBeenLastCalledWith("clep", 12),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Search service unavailable",
    );
  });

  it("offers an accessible retry for a failed vault search", async () => {
    useSearchMock.mockImplementation((query: string) => ({
      data: undefined,
      isFetching: false,
      isError: query === "clep",
      error: query === "clep" ? new Error("Search failed") : null,
      refetch: searchRefetchMock,
    }));
    const user = userEvent.setup();
    render(<CommandPalette />);

    await user.type(
      screen.getByRole("textbox", { name: "Command query" }),
      "clep",
    );
    await waitFor(() =>
      expect(useSearchMock).toHaveBeenLastCalledWith("clep", 12),
    );
    await user.click(
      screen.getByRole("button", { name: /retry (vault )?search/i }),
    );

    expect(searchRefetchMock).toHaveBeenCalledOnce();
  });
});
