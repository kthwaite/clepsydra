import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBoardStore } from "#/store/board";
import { filterTasks, TaskingScreen } from "../TaskingScreen";
import {
  BOARD_FIXTURE,
  BOARD_FIXTURE_WITH_NO_SLUG_OP,
  stubBoardFetch,
} from "./fixtures";

const { operations, tasks } = BOARD_FIXTURE;

/** Fresh client per render — retry off so error states surface immediately. */
function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TaskingScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useBoardStore.setState({
    mode: "card",
    opFilter: "ALL",
    cycleSel: "",
    railOpen: true,
    editTaskId: null,
    taskModal: null,
    cycleModal: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── filterTasks ───────────────────────────────────────────────────────────────

describe("filterTasks", () => {
  it("ALL returns all tasks", () => {
    expect(filterTasks(tasks, operations, "ALL")).toHaveLength(tasks.length);
  });

  it("specific op project filters to matching tasks only", () => {
    const result = filterTasks(tasks, operations, "alpha");
    expect(result.every((t) => t.project === "alpha")).toBe(true);
    expect(result).toHaveLength(3); // t1, t2, t5
  });

  it("specific op project with no match returns empty", () => {
    const result = filterTasks(tasks, operations, "ghost");
    expect(result).toHaveLength(0);
  });

  it("UNFILED returns tasks with null project", () => {
    const result = filterTasks(tasks, operations, "UNFILED");
    expect(result.every((t) => !t.project)).toBe(true);
    expect(result).toHaveLength(1); // t4
  });

  it("UNFILED returns tasks with project not matching any operation", () => {
    const orphan = { ...tasks[0], project: "orphan-project" };
    const result = filterTasks(
      [orphan, ...tasks.slice(1)],
      operations,
      "UNFILED",
    );
    // orphan + t4 (null project)
    expect(result.some((t) => t.project === "orphan-project")).toBe(true);
    expect(result.some((t) => !t.project)).toBe(true);
  });

  it("UNFILED with no unfiled tasks returns empty array", () => {
    const cleanTasks = tasks.filter(
      (t) => t.project === "alpha" || t.project === "beta",
    );
    const result = filterTasks(cleanTasks, operations, "UNFILED");
    expect(result).toHaveLength(0);
  });
});

// ── TaskingScreen smoke ───────────────────────────────────────────────────────

describe("TaskingScreen smoke", () => {
  it("renders the loading state while the board query is in flight", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    renderScreen();
    expect(screen.getByText("LOADING")).toBeInTheDocument();
  });

  it("renders the error state when the board fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );
    renderScreen();
    expect(
      await screen.findByText(/ERROR — board unavailable/),
    ).toBeInTheDocument();
  });

  it("renders the board shell when data loads successfully", async () => {
    stubBoardFetch();
    renderScreen();
    expect(await screen.findByText("TASKING BOARD")).toBeInTheDocument();
    expect(screen.getByText("SCOPE")).toBeInTheDocument();
  });

  it("renders all mode buttons after load", async () => {
    stubBoardFetch();
    renderScreen();
    await screen.findByText("TASKING BOARD");
    expect(screen.getByRole("tab", { name: /CARD/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /BACKLOG/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /CYCLE/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /TIMELINE/ })).toBeInTheDocument();
  });

  it("renders ALL OPS rail row after load", async () => {
    stubBoardFetch();
    renderScreen();
    await screen.findByText("TASKING BOARD");
    expect(screen.getByText("ALL OPS")).toBeInTheDocument();
  });

  it("shows kanban columns in card mode (default)", async () => {
    stubBoardFetch();
    renderScreen();
    await screen.findByText("TASKING BOARD");
    // KanbanView renders column labels from board.columns
    expect(screen.getByTestId("kb-col-INTAKE")).toBeInTheDocument();
    expect(screen.getByTestId("kb-col-FIELD")).toBeInTheDocument();
    expect(screen.getByTestId("kb-col-SEALED")).toBeInTheDocument();
  });

  it("shows the backlog register in backlog mode (not the placeholder)", async () => {
    useBoardStore.setState({ mode: "backlog" });
    stubBoardFetch();
    renderScreen();
    await screen.findByText("TASKING BOARD");
    // BacklogView's header row is mounted
    expect(screen.getByText("FILE-ID")).toBeInTheDocument();
    expect(screen.queryByText(/COMING SOON/)).not.toBeInTheDocument();
  });

  it("op with null project: clicking its row highlights it, shows op-meta, zero tasks", async () => {
    stubBoardFetch(BOARD_FIXTURE_WITH_NO_SLUG_OP);
    renderScreen();
    await screen.findByText("TASKING BOARD");

    const row = screen.getByText("OPS-3").closest("button")!;
    await userEvent.click(row);

    // opFilter falls back to the op code; the row highlights consistently
    expect(useBoardStore.getState().opFilter).toBe("OPS-3");
    expect(row.className).toContain("border-l-[var(--hot)]");

    // op-meta line resolves the same op (LEAD label only renders there)
    expect(screen.getByText("LEAD")).toBeInTheDocument();
    expect(screen.getByText("Riva")).toBeInTheDocument();

    // no task carries the op code as a project → zero visible tasks
    const openLabel = screen.getByText("OPEN");
    const openStat = openLabel.parentElement!.querySelector("span:last-child");
    expect(openStat?.textContent).toBe("00");
  });
});

// ── kanban + button project preset (mirrors ScopeRail) ───────────────────────

describe("TaskingScreen — kanban column + project preset", () => {
  it("op with slug selected: + presets both status and project", async () => {
    useBoardStore.setState({ opFilter: "alpha" });
    stubBoardFetch();
    renderScreen();
    await screen.findByText("TASKING BOARD");

    await userEvent.click(screen.getByTestId("kb-add-FIELD"));
    expect(useBoardStore.getState().taskModal).toEqual({
      status: "FIELD",
      project: "alpha",
    });
  });

  it("ALL ops: + presets status only, no project key", async () => {
    stubBoardFetch();
    renderScreen();
    await screen.findByText("TASKING BOARD");

    await userEvent.click(screen.getByTestId("kb-add-FIELD"));
    const modal = useBoardStore.getState().taskModal;
    expect(modal).toEqual({ status: "FIELD" });
    expect(modal).not.toHaveProperty("project");
  });

  it("slug-less op selected: + omits the project preset (a code is not a project)", async () => {
    useBoardStore.setState({ opFilter: "OPS-3" });
    stubBoardFetch(BOARD_FIXTURE_WITH_NO_SLUG_OP);
    renderScreen();
    await screen.findByText("TASKING BOARD");

    await userEvent.click(screen.getByTestId("kb-add-FIELD"));
    const modal = useBoardStore.getState().taskModal;
    expect(modal).toEqual({ status: "FIELD" });
    expect(modal).not.toHaveProperty("project");
  });
});
