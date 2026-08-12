import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler } from "react";
import { flushSync } from "react-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  navigateMock,
  openTabMock,
  useSearchMock,
  useTagsMock,
  workspaceStateMock,
} = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  openTabMock: vi.fn(),
  useSearchMock: vi.fn(() => ({ data: [] })),
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
}));

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
vi.mock("#/store/workspace", () => {
  const useWorkspaceStore = Object.assign(
    (selector: (state: unknown) => unknown) => selector(workspaceStateMock),
    { getState: () => workspaceStateMock },
  );
  return { useWorkspaceStore };
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

  it("opens the Academic library with the keyboard", async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);

    const query = screen.getByRole("textbox", { name: "Command query" });
    await user.type(query, "Open Academic Library{Enter}");

    expect(navigateMock).toHaveBeenCalledWith({ to: "/academic" });
    expect(useUiStore.getState().isSearchOpen).toBe(false);
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
