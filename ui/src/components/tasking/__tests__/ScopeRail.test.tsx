import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
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
  it("renders the approved scope and project labels when open", () => {
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    expect(screen.getByText("Scope")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("Cycles")).toBeInTheDocument();
  });

  it("renders All projects row with total task count", () => {
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    expect(screen.getByText("All projects")).toBeInTheDocument();
    // total tasks count appears as the badge (all 5)
    expect(
      screen.getByRole("button", { name: /All projects/ }),
    ).toBeInTheDocument();
  });

  it("renders one row per operation with correct count", () => {
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    // OPS-1 has 3 tasks with project=alpha (t1, t2, t5)
    expect(screen.getByText("OPS-1")).toBeInTheDocument();
    // OPS-2 has 1 task with project=beta (t3)
    expect(screen.getByText("OPS-2")).toBeInTheDocument();
  });

  it("renders No project row when unfiled tasks exist", () => {
    // BOARD_FIXTURE has t4 with project=null
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    expect(screen.getByText("No project")).toBeInTheDocument();
  });

  it("does NOT render No project row when no unfiled tasks", () => {
    const cleanTasks = tasks.filter(
      (t) => t.project === "alpha" || t.project === "beta",
    );
    wrap(
      <ScopeRail operations={operations} cycles={cycles} tasks={cleanTasks} />,
    );
    expect(screen.queryByText("No project")).not.toBeInTheDocument();
  });

  it("renders a real cycle with its code, window, state pip, and task count", () => {
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    const row = screen.getByText("C-01").closest("button");

    expect(row).not.toBeNull();
    expect(within(row!).getByText("C-01")).toBeInTheDocument();
    expect(within(row!).getByText("05.26 — 06.08")).toBeInTheDocument();
    expect(within(row!).getByText("3")).toBeInTheDocument();
    expect(row!.querySelector(".animate-pulse")).toHaveStyle({
      background: "var(--cool)",
    });
  });

  it("renders Backlog as unscheduled and counts only tasks without a cycle", () => {
    const taskWithAnotherCycle = {
      ...tasks[0],
      id: "task-with-another-cycle",
      cycle: "C-99",
    };
    wrap(
      <ScopeRail
        operations={operations}
        cycles={cycles}
        tasks={[...tasks, taskWithAnotherCycle]}
      />,
    );
    const row = screen.getByText("Backlog").closest("button");

    expect(row).not.toBeNull();
    expect(within(row!).getByText("Backlog")).toBeInTheDocument();
    expect(within(row!).getByText("unscheduled")).toBeInTheDocument();
    expect(within(row!).getByText("2")).toBeInTheDocument();
  });

  it("renders the + New task button", () => {
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    expect(screen.getByText(/New task/)).toBeInTheDocument();
  });

  it("collapse button sets railOpen to false", async () => {
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    const collapseBtn = screen.getByTitle("Collapse");
    await userEvent.click(collapseBtn);
    expect(useBoardStore.getState().railOpen).toBe(false);
  });

  it("collapsed state renders Scope › popout button", () => {
    useBoardStore.setState({ railOpen: false });
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    expect(screen.getByText(/Scope/)).toBeInTheDocument();
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

  it("clicking All projects sets opFilter to ALL", async () => {
    useBoardStore.setState({ opFilter: "alpha" });
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    const allProjectsRow = screen.getByText("All projects").closest("button")!;
    await userEvent.click(allProjectsRow);
    expect(useBoardStore.getState().opFilter).toBe("ALL");
  });

  it("clicking No project sets opFilter to UNFILED", async () => {
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    const noProjectRow = screen.getByText("No project").closest("button")!;
    await userEvent.click(noProjectRow);
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

  it("clicking Backlog sets cycleSel=BACKLOG and mode=cycle", async () => {
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    const backlogRow = screen.getByText("Backlog").closest("button")!;
    await userEvent.click(backlogRow);
    const state = useBoardStore.getState();
    expect(state.cycleSel).toBe("BACKLOG");
    expect(state.mode).toBe("cycle");
  });

  it("applies active classes to the selected real cycle row", () => {
    useBoardStore.setState({ mode: "cycle", cycleSel: "C-01" });
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    const row = screen.getByText("C-01").closest("button");

    expect(row).toHaveClass("border-l-[var(--hot)]", "bg-[var(--paper)]");
  });

  it("applies active classes to the selected backlog row", () => {
    useBoardStore.setState({ mode: "cycle", cycleSel: "BACKLOG" });
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    const row = screen.getByText("Backlog").closest("button");

    expect(row).toHaveClass("border-l-[var(--hot)]", "bg-[var(--paper)]");
  });

  it("+ New task opens taskModal with no project when ALL", async () => {
    useBoardStore.setState({ opFilter: "ALL" });
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    const btn = screen.getByText(/New task/);
    await userEvent.click(btn);
    expect(useBoardStore.getState().taskModal).toEqual({});
  });

  it("+ New task opens taskModal with project preset when op is selected", async () => {
    useBoardStore.setState({ opFilter: "alpha" });
    wrap(<ScopeRail operations={operations} cycles={cycles} tasks={tasks} />);
    const btn = screen.getByText(/New task/);
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

  it("+ New task omits the project preset (a code is not a project)", async () => {
    useBoardStore.setState({ opFilter: "OPS-3" });
    wrap(
      <ScopeRail operations={opsWithNoSlug} cycles={cycles} tasks={tasks} />,
    );
    const btn = screen.getByText(/New task/);
    await userEvent.click(btn);
    expect(useBoardStore.getState().taskModal).toEqual({});
  });

  it("badge for a slug-less op matches what clicking reveals (zero)", () => {
    // Three tasks with project: null must NOT count toward the slug-less
    // op's badge — only a task whose project equals the op's own key (its
    // code) would, and none do here. t.project === op.project (null===null)
    // is the bug this guards against.
    const nullProjectTasks = [
      { ...tasks[0], id: "null-1", project: null },
      { ...tasks[1], id: "null-2", project: null },
      { ...tasks[2], id: "null-3", project: null },
    ];
    wrap(
      <ScopeRail
        operations={opsWithNoSlug}
        cycles={cycles}
        tasks={nullProjectTasks}
      />,
    );
    const row = screen.getByText("OPS-3").closest("button")!;
    expect(within(row).getByText("0")).toBeInTheDocument();
  });
});
