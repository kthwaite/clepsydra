import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBoardStore } from "#/store/board";
import { filterTasks, TaskingScreen } from "../TaskingScreen";
import { BOARD_FIXTURE, stubBoardFetch } from "./fixtures";

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

  it("shows CARD VIEW body placeholder in default mode", async () => {
    stubBoardFetch();
    renderScreen();
    await screen.findByText("TASKING BOARD");
    expect(screen.getByText(/CARD VIEW/i)).toBeInTheDocument();
  });
});
