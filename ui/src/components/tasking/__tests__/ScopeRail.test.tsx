import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { useBoardStore } from "#/store/board";
import { deriveProjectScopes } from "../board-projects";
import { hasUnfiledTasks, ScopeRail } from "../ScopeRail";
import { BOARD_FIXTURE, NO_SLUG_OP, PROJECT_SCOPES } from "./fixtures";

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
    expect(hasUnfiledTasks(tasks)).toBe(true);
  });

  it("returns false when every task carries a project slug", () => {
    const cleanTasks = tasks.filter(
      (t) => t.project === "alpha" || t.project === "beta",
    );
    expect(hasUnfiledTasks(cleanTasks)).toBe(false);
  });

  it("returns false for a task whose slug matches no operation", () => {
    const orphan = { ...tasks[0], project: "ghost-project" };
    expect(hasUnfiledTasks([orphan])).toBe(false);
  });

  it("returns false for empty task list", () => {
    expect(hasUnfiledTasks([])).toBe(false);
  });
});

// ── ScopeRail render ──────────────────────────────────────────────────────────

describe("ScopeRail", () => {
  it("shows a project title instead of its generated filename without changing its filter key", async () => {
    const operation = {
      ...NO_SLUG_OP,
      code: "20260930.LAMP-PROJECT.A1B2C3",
      name: "Lamp project",
    };
    wrap(
      <ScopeRail
        projects={deriveProjectScopes([operation], [])}
        cycles={cycles}
        tasks={tasks}
      />,
    );
    const row = screen.getByRole("button", { name: /Lamp project/ });
    expect(within(row).queryByText(operation.code)).not.toBeInTheDocument();
    await userEvent.click(row);
    expect(useBoardStore.getState().opFilter).toBe(operation.code);
  });

  it("renders No project row when unfiled tasks exist", () => {
    // BOARD_FIXTURE has t4 with project=null
    wrap(<ScopeRail projects={PROJECT_SCOPES} cycles={cycles} tasks={tasks} />);
    expect(screen.getByText("No project")).toBeInTheDocument();
  });

  it("does NOT render No project row when no unfiled tasks", () => {
    const cleanTasks = tasks.filter(
      (t) => t.project === "alpha" || t.project === "beta",
    );
    wrap(
      <ScopeRail
        projects={PROJECT_SCOPES}
        cycles={cycles}
        tasks={cleanTasks}
      />,
    );
    expect(screen.queryByText("No project")).not.toBeInTheDocument();
  });

  it("renders a real cycle with its date window and task count", () => {
    wrap(<ScopeRail projects={PROJECT_SCOPES} cycles={cycles} tasks={tasks} />);
    const row = screen.getByRole("button", { name: /C-01/ });

    expect(within(row).getByText("26 May – 8 Jun")).toBeInTheDocument();
    expect(within(row).getByText("3")).toBeInTheDocument();
  });

  it("counts only tasks without a Cycle in Backlog", () => {
    const taskWithAnotherCycle = {
      ...tasks[0],
      id: "task-with-another-cycle",
      cycle: "C-99",
    };
    wrap(
      <ScopeRail
        projects={PROJECT_SCOPES}
        cycles={cycles}
        tasks={[...tasks, taskWithAnotherCycle]}
      />,
    );
    const row = screen.getByRole("button", { name: /Backlog/ });

    expect(within(row).getByText("2")).toBeInTheDocument();
  });

  it("collapse button sets railOpen to false", async () => {
    wrap(<ScopeRail projects={PROJECT_SCOPES} cycles={cycles} tasks={tasks} />);
    const collapseBtn = screen.getByTitle("Collapse");
    await userEvent.click(collapseBtn);
    expect(useBoardStore.getState().railOpen).toBe(false);
  });

  it("clicking popout reopens rail", async () => {
    useBoardStore.setState({ railOpen: false });
    wrap(<ScopeRail projects={PROJECT_SCOPES} cycles={cycles} tasks={tasks} />);
    const popout = screen.getByTitle("Open scope rail");
    await userEvent.click(popout);
    expect(useBoardStore.getState().railOpen).toBe(true);
  });

  it("clicking a project row sets opFilter to its slug", async () => {
    wrap(<ScopeRail projects={PROJECT_SCOPES} cycles={cycles} tasks={tasks} />);
    const opsRow = screen.getByRole("button", { name: /Operation Alpha/ });
    await userEvent.click(opsRow);
    expect(useBoardStore.getState().opFilter).toBe("alpha");
  });

  it("clicking All projects sets opFilter to ALL", async () => {
    useBoardStore.setState({ opFilter: "alpha" });
    wrap(<ScopeRail projects={PROJECT_SCOPES} cycles={cycles} tasks={tasks} />);
    const allProjectsRow = screen.getByRole("button", { name: /All projects/ });
    await userEvent.click(allProjectsRow);
    expect(useBoardStore.getState().opFilter).toBe("ALL");
  });

  it("clicking No project sets opFilter to UNFILED", async () => {
    wrap(<ScopeRail projects={PROJECT_SCOPES} cycles={cycles} tasks={tasks} />);
    const noProjectRow = screen.getByRole("button", { name: /No project/ });
    await userEvent.click(noProjectRow);
    expect(useBoardStore.getState().opFilter).toBe("UNFILED");
  });

  it("clicking a cycle row sets cycleSel and mode to cycle", async () => {
    wrap(<ScopeRail projects={PROJECT_SCOPES} cycles={cycles} tasks={tasks} />);
    const c01Row = screen.getByRole("button", { name: /C-01/ });
    await userEvent.click(c01Row);
    const state = useBoardStore.getState();
    expect(state.cycleSel).toBe("C-01");
    expect(state.mode).toBe("cycle");
  });

  it("clicking Backlog sets cycleSel=BACKLOG and mode=cycle", async () => {
    wrap(<ScopeRail projects={PROJECT_SCOPES} cycles={cycles} tasks={tasks} />);
    const backlogRow = screen.getByRole("button", { name: /Backlog/ });
    await userEvent.click(backlogRow);
    const state = useBoardStore.getState();
    expect(state.cycleSel).toBe("BACKLOG");
    expect(state.mode).toBe("cycle");
  });

  it("+ cycle button opens cycleModal with kind=new", async () => {
    wrap(<ScopeRail projects={PROJECT_SCOPES} cycles={cycles} tasks={tasks} />);
    const addBtn = screen.getByTitle("New cycle");
    await userEvent.click(addBtn);
    expect(useBoardStore.getState().cycleModal).toEqual({ kind: "new" });
  });
});

// ── op without a project slug (canonical key = op.code) ──────────────────────

describe("ScopeRail — op with null project", () => {
  const scopesWithNoSlug = deriveProjectScopes(
    [...operations, NO_SLUG_OP],
    tasks,
  );

  it("clicking its row sets opFilter to the op code", async () => {
    wrap(
      <ScopeRail projects={scopesWithNoSlug} cycles={cycles} tasks={tasks} />,
    );
    const row = screen.getByRole("button", { name: /Operation Gamma/ });
    await userEvent.click(row);
    expect(useBoardStore.getState().opFilter).toBe("OPS-3");
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
        projects={scopesWithNoSlug}
        cycles={cycles}
        tasks={nullProjectTasks}
      />,
    );
    const row = screen.getByRole("button", { name: /Operation Gamma/ });
    expect(within(row).getByText("0")).toBeInTheDocument();
  });
});

// ── synthesized scope (task slug with no PROJECT page) ───────────────────────

describe("ScopeRail — synthesized project scope", () => {
  const ghostTask = { ...tasks[0], id: "tg", project: "ghost" };
  const tasksWithGhost = [...tasks, ghostTask];
  const scopes = deriveProjectScopes(operations, tasksWithGhost);

  it("header count equals the number of project scopes", () => {
    wrap(
      <ScopeRail projects={scopes} cycles={cycles} tasks={tasksWithGhost} />,
    );
    const header = screen.getByText("Projects").parentElement;
    assert(header !== null);
    expect(within(header).getByText("3")).toBeInTheDocument();
  });

  it("renders the synthesized row with its task count", () => {
    wrap(
      <ScopeRail projects={scopes} cycles={cycles} tasks={tasksWithGhost} />,
    );
    const row = screen.getByRole("button", { name: /GHOST/ });
    expect(within(row).getByText("1")).toBeInTheDocument();
  });

  it("clicking the row sets opFilter to the slug", async () => {
    wrap(
      <ScopeRail projects={scopes} cycles={cycles} tasks={tasksWithGhost} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /GHOST/ }));
    expect(useBoardStore.getState().opFilter).toBe("ghost");
  });

  it("does not count the slug's tasks as No project", () => {
    wrap(
      <ScopeRail projects={scopes} cycles={cycles} tasks={tasksWithGhost} />,
    );
    const row = screen.getByRole("button", { name: /No project/ });
    expect(within(row).getByText("1")).toBeInTheDocument(); // t4 only
  });
});
