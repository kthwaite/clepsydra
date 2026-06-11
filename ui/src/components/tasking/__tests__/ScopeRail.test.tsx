import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBoardStore } from "#/store/board";
import { hasUnfiledTasks, ScopeRail } from "../ScopeRail";
import { BOARD_FIXTURE, NO_SLUG_OP } from "./fixtures";

const { operations, cycles, tasks } = BOARD_FIXTURE;

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
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

// ── hasUnfiledTasks helper ────────────────────────────────────────────────────

describe("hasUnfiledTasks", () => {
  it("returns true when a task has null project", () => {
    expect(hasUnfiledTasks(tasks, operations)).toBe(true);
  });

  it("returns false when all tasks belong to known operations", () => {
    const cleanTasks = tasks.filter(
      (t) => t.project === "alpha" || t.project === "beta",
    );
    expect(hasUnfiledTasks(cleanTasks, operations)).toBe(false);
  });

  it("returns true when a task has a project that matches no operation", () => {
    const orphan = { ...tasks[0], project: "ghost-project" };
    expect(hasUnfiledTasks([orphan], operations)).toBe(true);
  });

  it("returns false for empty task list", () => {
    expect(hasUnfiledTasks([], operations)).toBe(false);
  });
});

// ── ScopeRail render ──────────────────────────────────────────────────────────

describe("ScopeRail", () => {
  it("renders the SCOPE header when open", () => {
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    expect(screen.getByText("SCOPE")).toBeInTheDocument();
  });

  it("renders ALL OPS row with total task count", () => {
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    expect(screen.getByText("ALL OPS")).toBeInTheDocument();
    // total tasks count appears as the badge (all 5)
    expect(screen.getByRole("button", { name: /ALL OPS/ })).toBeInTheDocument();
  });

  it("renders one row per operation with correct count", () => {
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    // OPS-1 has 3 tasks with project=alpha (t1, t2, t5)
    expect(screen.getByText("OPS-1")).toBeInTheDocument();
    // OPS-2 has 1 task with project=beta (t3)
    expect(screen.getByText("OPS-2")).toBeInTheDocument();
  });

  it("renders UNFILED row when unfiled tasks exist", () => {
    // BOARD_FIXTURE has t4 with project=null
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    expect(screen.getByText("UNFILED")).toBeInTheDocument();
  });

  it("does NOT render UNFILED row when no unfiled tasks", () => {
    const cleanTasks = tasks.filter(
      (t) => t.project === "alpha" || t.project === "beta",
    );
    wrap(
      <ScopeRail operations={operations} cycles={cycles} tasks={cleanTasks} />,
    );
    expect(screen.queryByText("UNFILED")).not.toBeInTheDocument();
  });

  it("renders cycle rows with codes", () => {
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    expect(screen.getByText("C-01")).toBeInTheDocument();
    expect(screen.getByText("C-02")).toBeInTheDocument();
  });

  it("renders BKLG pseudo-row", () => {
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    expect(screen.getByText("BKLG")).toBeInTheDocument();
  });

  it("renders the + NEW TASKING button", () => {
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    expect(screen.getByText(/NEW TASKING/)).toBeInTheDocument();
  });

  it("collapse button sets railOpen to false", async () => {
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    const collapseBtn = screen.getByTitle("Collapse");
    await userEvent.click(collapseBtn);
    expect(useBoardStore.getState().railOpen).toBe(false);
  });

  it("collapsed state renders SCOPE › popout button", () => {
    useBoardStore.setState({ railOpen: false });
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    expect(screen.getByText(/SCOPE/)).toBeInTheDocument();
    expect(screen.getByTitle("Open scope rail")).toBeInTheDocument();
  });

  it("clicking popout reopens rail", async () => {
    useBoardStore.setState({ railOpen: false });
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    const popout = screen.getByTitle("Open scope rail");
    await userEvent.click(popout);
    expect(useBoardStore.getState().railOpen).toBe(true);
  });

  it("clicking an operation row sets opFilter to op.project", async () => {
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    const opsRow = screen.getByText("OPS-1").closest("button")!;
    await userEvent.click(opsRow);
    expect(useBoardStore.getState().opFilter).toBe("alpha");
  });

  it("clicking ALL OPS sets opFilter to ALL", async () => {
    useBoardStore.setState({ opFilter: "alpha" });
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    const allOpsRow = screen.getByText("ALL OPS").closest("button")!;
    await userEvent.click(allOpsRow);
    expect(useBoardStore.getState().opFilter).toBe("ALL");
  });

  it("clicking UNFILED sets opFilter to UNFILED", async () => {
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    const unfiledRow = screen.getByText("UNFILED").closest("button")!;
    await userEvent.click(unfiledRow);
    expect(useBoardStore.getState().opFilter).toBe("UNFILED");
  });

  it("clicking a cycle row sets cycleSel and mode to cycle", async () => {
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    const c01Row = screen.getByText("C-01").closest("button")!;
    await userEvent.click(c01Row);
    const state = useBoardStore.getState();
    expect(state.cycleSel).toBe("C-01");
    expect(state.mode).toBe("cycle");
  });

  it("clicking BKLG sets cycleSel=BACKLOG and mode=cycle", async () => {
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    const bklgRow = screen.getByText("BKLG").closest("button")!;
    await userEvent.click(bklgRow);
    const state = useBoardStore.getState();
    expect(state.cycleSel).toBe("BACKLOG");
    expect(state.mode).toBe("cycle");
  });

  it("+ NEW TASKING opens taskModal with no project when ALL", async () => {
    useBoardStore.setState({ opFilter: "ALL" });
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    const btn = screen.getByText(/NEW TASKING/);
    await userEvent.click(btn);
    expect(useBoardStore.getState().taskModal).toEqual({});
  });

  it("+ NEW TASKING opens taskModal with project preset when op is selected", async () => {
    useBoardStore.setState({ opFilter: "alpha" });
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    const btn = screen.getByText(/NEW TASKING/);
    await userEvent.click(btn);
    expect(useBoardStore.getState().taskModal).toEqual({ project: "alpha" });
  });

  it("+ cycle button opens cycleModal with kind=new", async () => {
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    const addBtn = screen.getByTitle("New cycle");
    await userEvent.click(addBtn);
    expect(useBoardStore.getState().cycleModal).toEqual({ kind: "new" });
  });
});

// ── op without a project slug (canonical key = op.code) ──────────────────────

describe("ScopeRail — op with null project", () => {
  const opsWithNoSlug = [...operations, NO_SLUG_OP];

  it("clicking its row sets opFilter to the op code", async () => {
    wrap(
      <ScopeRail operations={opsWithNoSlug} cycles={cycles} tasks={tasks} />,
    );
    const row = screen.getByText("OPS-3").closest("button")!;
    await userEvent.click(row);
    expect(useBoardStore.getState().opFilter).toBe("OPS-3");
  });

  it("highlights the row when opFilter equals the op code", () => {
    useBoardStore.setState({ opFilter: "OPS-3" });
    wrap(
      <ScopeRail operations={opsWithNoSlug} cycles={cycles} tasks={tasks} />,
    );
    const row = screen.getByText("OPS-3").closest("button")!;
    expect(row.className).toContain("border-l-[var(--hot)]");
  });

  it("+ NEW TASKING omits the project preset (a code is not a project)", async () => {
    useBoardStore.setState({ opFilter: "OPS-3" });
    wrap(
      <ScopeRail operations={opsWithNoSlug} cycles={cycles} tasks={tasks} />,
    );
    const btn = screen.getByText(/NEW TASKING/);
    await userEvent.click(btn);
    expect(useBoardStore.getState().taskModal).toEqual({});
  });
});
