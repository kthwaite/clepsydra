import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const {
  navigateMock,
  openTabMock,
  searchRefetchMock,
  useSearchMock,
  useTagsMock,
  workspaceStateMock,
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
    workspaceStateMock: {
      tabs: [] as Array<{
        id: string;
        type: string;
        path: string;
        label: string;
        quireId?: string;
      }>,
      quires: {} as Record<
        string,
        {
          id: string;
          name: string;
          color: string;
          collapsed: boolean;
        }
      >,
      activeTabId: null as string | null,
      createQuire: vi.fn(),
      addTabToQuire: vi.fn(),
      removeTabFromQuire: vi.fn(),
    },
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
vi.mock("#/hooks/useFolioHistoryNavigation", () => ({
  useActivateTabWithFolioHistory: () => vi.fn(),
  useLeaveFolioWorkspace: () => (proceed: () => void) => proceed(),
}));
vi.mock("#/store/workspace", () => {
  const useWorkspaceStore = Object.assign(
    (selector: (state: unknown) => unknown) => selector(workspaceStateMock),
    { getState: () => workspaceStateMock },
  );
  const selectActiveTab = (state: typeof workspaceStateMock) =>
    state.tabs.find((t) => t.id === state.activeTabId);
  return { useWorkspaceStore, selectActiveTab };
});

import { CommandPalette } from "#/components/codex/CommandPalette";
import { STATIC_COMMANDS } from "#/components/codex/commandRegistry";
import { todayJournalPath } from "#/lib/journal";
import { useUiStore } from "#/store/ui";

describe("CommandPalette keyboard navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceStateMock.tabs = [];
    workspaceStateMock.quires = {};
    workspaceStateMock.activeTabId = null;
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

  it("opens Reference Repairs with the keyboard", async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);

    const query = screen.getByRole("textbox", { name: "Command query" });
    await user.type(query, "Open Reference Repairs{Enter}");

    expect(navigateMock).toHaveBeenCalledWith({ to: "/repairs" });
    expect(useUiStore.getState().isSearchOpen).toBe(false);
  });

  it("opens the Rubbish Bin with the keyboard", async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);

    const query = screen.getByRole("textbox", { name: "Command query" });
    await user.type(query, "Open Rubbish Bin{Enter}");

    expect(navigateMock).toHaveBeenCalledWith({ to: "/rubbish" });
    expect(useUiStore.getState().isSearchOpen).toBe(false);
  });

  it("opens the Academic library with the keyboard", async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);

    const query = screen.getByRole("textbox", { name: "Command query" });
    await user.type(query, "Open Academic Library{Enter}");

    expect(navigateMock).toHaveBeenCalledWith({ to: "/academic" });
    expect(useUiStore.getState().isSearchOpen).toBe(false);
  });

  it("announces while the current query is waiting for search", async () => {
    useSearchMock.mockImplementation((query: string) => ({
      data: undefined,
      isFetching: query === "clep",
      isError: false,
      error: null,
      refetch: searchRefetchMock,
    }));
    render(<CommandPalette />);
    const input = screen.getByRole("textbox", { name: "Command query" });

    fireEvent.change(input, { target: { value: "clep" } });

    expect(screen.getByRole("status")).toHaveTextContent(/searching/i);
    await waitFor(() =>
      expect(useSearchMock).toHaveBeenLastCalledWith("clep", 12),
    );
    expect(screen.getByRole("status")).toHaveTextContent(/searching/i);
  });

  it("announces a backend error only while it belongs to the current query", async () => {
    useSearchMock.mockImplementation((query: string) => ({
      data: undefined,
      isFetching: false,
      isError: query === "clep",
      error: query === "clep" ? new Error("Search service unavailable") : null,
      refetch: searchRefetchMock,
    }));
    const user = userEvent.setup();
    render(<CommandPalette />);
    const input = screen.getByRole("textbox", { name: "Command query" });

    await user.type(input, "clep");
    await waitFor(() =>
      expect(useSearchMock).toHaveBeenLastCalledWith("clep", 12),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Search service unavailable",
    );

    fireEvent.change(input, { target: { value: "cleps" } });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /retry (vault )?search/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/searching/i);
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

  it("keeps a newer keyed result visible when an older query resolves last", async () => {
    type SearchState = {
      data: unknown[] | undefined;
      isFetching: boolean;
      isError: boolean;
      error: Error | null;
      refetch: typeof searchRefetchMock;
    };
    const alpha = deferred<unknown[]>();
    const beta = deferred<unknown[]>();
    const listeners = new Set<() => void>();
    const states = new Map<string, SearchState>();
    let revision = 0;
    const publish = (query: string, pending: Promise<unknown[]>) => {
      states.set(query, {
        data: undefined,
        isFetching: true,
        isError: false,
        error: null,
        refetch: searchRefetchMock,
      });
      void pending.then((data) => {
        states.set(query, {
          data,
          isFetching: false,
          isError: false,
          error: null,
          refetch: searchRefetchMock,
        });
        revision += 1;
        listeners.forEach((listener) => listener());
      });
    };
    publish("alpha", alpha.promise);
    publish("beta", beta.promise);

    function useDeferredSearch(query: string): SearchState {
      useSyncExternalStore(
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => revision,
        () => revision,
      );
      return (
        states.get(query) ?? {
          data: [],
          isFetching: false,
          isError: false,
          error: null,
          refetch: searchRefetchMock,
        }
      );
    }
    useSearchMock.mockImplementation(useDeferredSearch);
    const user = userEvent.setup();
    render(<CommandPalette />);
    const input = screen.getByRole("textbox", { name: "Command query" });

    await user.type(input, "alpha");
    await waitFor(() =>
      expect(useSearchMock).toHaveBeenLastCalledWith("alpha", 12),
    );
    fireEvent.change(input, { target: { value: "beta" } });
    expect(screen.getByRole("status")).toHaveTextContent(/searching/i);
    await waitFor(() =>
      expect(useSearchMock).toHaveBeenLastCalledWith("beta", 12),
    );

    await act(async () => {
      beta.resolve([
        {
          page_id: "beta",
          path: "notes/beta.md",
          title: "Beta current",
          snippet: "current result",
          rank: -1,
        },
      ]);
      await beta.promise;
    });
    expect(await screen.findByText("Beta current")).toBeInTheDocument();

    await act(async () => {
      alpha.resolve([
        {
          page_id: "alpha",
          path: "notes/alpha.md",
          title: "Beta stale from alpha",
          snippet: "stale result",
          rank: -1,
        },
      ]);
      await alpha.promise;
    });
    expect(screen.queryByText("Beta stale from alpha")).not.toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(openTabMock).toHaveBeenCalledWith(
      "page",
      "notes/beta.md",
      "Beta current",
    );
    expect(openTabMock).not.toHaveBeenCalledWith(
      "page",
      "notes/alpha.md",
      "Beta stale from alpha",
    );
  });

  it("exposes every static command descriptor through the palette", () => {
    render(<CommandPalette />);
    const query = screen.getByRole("textbox", { name: "Command query" });

    for (const command of STATIC_COMMANDS) {
      fireEvent.change(query, { target: { value: command.title } });
      expect(screen.getByText(command.title)).toBeInTheDocument();
    }
  });

  it("preserves stable and dynamic Quire command IDs, labels, filtering, and actions", async () => {
    const user = userEvent.setup();
    workspaceStateMock.tabs = [
      {
        id: "tab-1",
        type: "page",
        path: "notes/alpha.md",
        label: "Alpha",
        quireId: "quire-1",
      },
    ];
    workspaceStateMock.quires = {
      "quire-1": {
        id: "quire-1",
        name: "Current",
        color: "sepia",
        collapsed: false,
      },
      "quire-2": {
        id: "quire-2",
        name: "Research",
        color: "verdigris",
        collapsed: false,
      },
    };
    workspaceStateMock.activeTabId = "tab-1";
    render(<CommandPalette />);

    await user.type(
      screen.getByRole("textbox", { name: "Command query" }),
      "Quire:",
    );

    expect(screen.getByText("quire.new")).toBeInTheDocument();
    expect(screen.getByText("quire.add.quire-2")).toBeInTheDocument();
    expect(screen.queryByText("quire.add.quire-1")).not.toBeInTheDocument();
    expect(screen.getByText("quire.remove")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: /quire\.add\.quire-2.*Quire: add active folio to Research/i,
      }),
    );
    expect(workspaceStateMock.addTabToQuire).toHaveBeenCalledWith(
      "tab-1",
      "quire-2",
    );
  });
});
