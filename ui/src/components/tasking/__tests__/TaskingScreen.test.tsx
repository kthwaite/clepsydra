import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardResponse } from "#/api/board";
import { EMPTY_FILTER_STATE, type FilterState } from "#/lib/filters/model";
import { useBoardStore } from "#/store/board";
import { filterTasks, TaskingScreen } from "../TaskingScreen";
import {
  BOARD_FIXTURE,
  BOARD_FIXTURE_WITH_NO_SLUG_OP,
  stubBoardFetch,
} from "./fixtures";

const { operations, tasks } = BOARD_FIXTURE;

/** Minimal 3-task fixture for filter-strip composition tests. */
const FILTER_FIXTURE: BoardResponse = {
  ...BOARD_FIXTURE,
  tasks: [
    {
      id: "f1",
      code: "TSK-F1",
      title: "Alpha task",
      body_excerpt: null,
      status: "INTAKE",
      priority: "P0",
      project: null,
      cycle: null,
      tags: [],
      checks: [],
      path: "tasks/f1.md",
      updated_at: "2026-06-01T00:00:00Z",
    },
    {
      id: "f2",
      code: "TSK-F2",
      title: "Beta task",
      body_excerpt: null,
      status: "INTAKE",
      priority: "P1",
      project: null,
      cycle: null,
      tags: [],
      checks: [],
      path: "tasks/f2.md",
      updated_at: "2026-06-01T00:00:00Z",
    },
    {
      id: "f3",
      code: "TSK-F3",
      title: "Gamma task",
      body_excerpt: null,
      status: "INTAKE",
      priority: "P2",
      project: null,
      cycle: null,
      tags: [],
      checks: [],
      path: "tasks/f3.md",
      updated_at: "2026-06-01T00:00:00Z",
    },
  ],
};

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

/**
 * Local stateful harness standing in for the /tasking route: TaskingScreen is
 * a controlled component (filterState/onFilterChange are route-owned props),
 * so filter-interaction tests need a real state round-trip the same way the
 * route's useMemo/navigate wiring provides it in production.
 */
function ControlledTaskingScreen({
  initial = EMPTY_FILTER_STATE,
}: {
  initial?: FilterState;
}) {
  const [filterState, setFilterState] = useState<FilterState>(initial);
  return (
    <TaskingScreen filterState={filterState} onFilterChange={setFilterState} />
  );
}

function renderScreenWithFilter(initial?: FilterState) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ControlledTaskingScreen initial={initial} />
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

  it("RETRY button refetches and renders board on success", async () => {
    let fetchAttempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        fetchAttempt++;
        if (fetchAttempt === 1) {
          return Promise.reject(new Error("network down"));
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(BOARD_FIXTURE),
        } as Response);
      }),
    );
    renderScreen();
    expect(
      await screen.findByText(/ERROR — board unavailable/),
    ).toBeInTheDocument();

    const retryButton = screen.getByRole("button", { name: /retry/i });
    await userEvent.click(retryButton);

    expect(await screen.findByTestId("kb-col-INTAKE")).toBeInTheDocument();
  });

  it("renders the board shell when data loads successfully", async () => {
    stubBoardFetch();
    renderScreen();
    expect(await screen.findByText("TASKING BOARD")).toBeInTheDocument();
    expect(screen.getByText("SCOPE")).toBeInTheDocument();
  });

  it("renders neutral mode labels after load", async () => {
    stubBoardFetch();
    renderScreen();
    await screen.findByText("TASKING BOARD");
    expect(screen.getByRole("tab", { name: "Board" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "List" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Cycles" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Timeline" })).toBeInTheDocument();
  });

  it("renders ALL OPS rail row after load", async () => {
    stubBoardFetch();
    renderScreen();
    await screen.findByText("TASKING BOARD");
    expect(screen.getByText("ALL OPS")).toBeInTheDocument();
  });

  it("shows fixed human-facing status labels in board mode", async () => {
    stubBoardFetch();
    renderScreen();
    await screen.findByText("TASKING BOARD");

    for (const [id, label] of [
      ["INTAKE", "Inbox"],
      ["TRIAGE", "Ready"],
      ["FIELD", "In Progress"],
      ["REVIEW", "Review"],
      ["SEALED", "Done"],
    ]) {
      expect(
        within(screen.getByTestId(`kb-col-${id}`)).getByText(label),
      ).toBeInTheDocument();
    }
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

  it("shows neutral priority descriptions in list mode", async () => {
    const priorityFixture: BoardResponse = {
      ...BOARD_FIXTURE,
      tasks: [
        ...BOARD_FIXTURE.tasks,
        {
          ...BOARD_FIXTURE.tasks[0],
          id: "priority-p0",
          code: "TSK-P0",
          title: "Critical task",
          priority: "P0",
        },
      ],
    };
    useBoardStore.setState({ mode: "backlog" });
    stubBoardFetch(priorityFixture);
    renderScreen();
    await screen.findByText("TASKING BOARD");

    for (const label of ["Critical", "High", "Medium", "Low"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
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

// ── integration: modal and panel mounting ────────────────────────────────────

describe("TaskingScreen — NewTaskModal + TaskEditPanel integration", () => {
  it("mounts NewTaskModal when taskModal is non-null", async () => {
    stubBoardFetch();
    renderScreen();
    await screen.findByText("TASKING BOARD");

    useBoardStore.setState({ taskModal: { status: "INTAKE" } });

    // The modal should appear and contain the title text
    const modal = await screen.findByTestId("new-task-modal");
    expect(modal).toBeInTheDocument();
    expect(modal).toHaveTextContent("NEW TASKING");
  });

  it("does not mount NewTaskModal when taskModal is null", async () => {
    stubBoardFetch();
    renderScreen();
    await screen.findByText("TASKING BOARD");

    expect(screen.queryByTestId("new-task-modal")).not.toBeInTheDocument();
  });

  it("mounts TaskEditPanel when editTaskId matches a task in board data", async () => {
    stubBoardFetch();
    renderScreen();
    await screen.findByText("TASKING BOARD");

    // t1 exists in BOARD_FIXTURE
    useBoardStore.setState({ editTaskId: "t1" });

    // Panel should appear with the task code
    expect(await screen.findByTestId("edit-panel")).toBeInTheDocument();
    expect(screen.getByTestId("edit-panel-code")).toHaveTextContent("TSK-0001");
  });

  it("does not mount TaskEditPanel when editTaskId is null", async () => {
    stubBoardFetch();
    renderScreen();
    await screen.findByText("TASKING BOARD");

    expect(screen.queryByTestId("edit-panel")).not.toBeInTheDocument();
  });

  it("does not mount TaskEditPanel when editTaskId does not match any task", async () => {
    stubBoardFetch();
    renderScreen();
    await screen.findByText("TASKING BOARD");

    useBoardStore.setState({ editTaskId: "ghost-task" });

    // Panel should NOT appear
    expect(screen.queryByTestId("edit-panel")).not.toBeInTheDocument();
  });

  it("switching editTaskId flushes the old panel's pending edit (key remount)", async () => {
    // Stub that also answers PATCH (the GET path returns the fixture)
    const stub = vi.fn((_url: string, opts?: RequestInit) => {
      if (opts?.method === "PATCH") {
        const patch = JSON.parse(opts.body as string) as Record<
          string,
          unknown
        >;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: "patched", ...patch }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(BOARD_FIXTURE),
      } as Response);
    });
    vi.stubGlobal("fetch", stub);

    renderScreen();
    await screen.findByText("TASKING BOARD");

    act(() => useBoardStore.setState({ editTaskId: "t1" }));
    await screen.findByTestId("edit-panel");

    // Type into the title — debounce (300ms) pending
    fireEvent.change(screen.getByTestId("edit-panel-title"), {
      target: { value: "SWITCH FLUSH" },
    });

    // Switch to another task — key={task.id} remounts the panel, and the
    // old panel's unmount flush must deliver the pending edit for t1
    act(() => useBoardStore.setState({ editTaskId: "t3" }));

    await waitFor(() => {
      const patchCalls = stub.mock.calls.filter(
        (args) =>
          typeof args[0] === "string" &&
          (args[0] as string).includes("/tasks/t1") &&
          (args[1] as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patchCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(
        (patchCalls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body.title).toBe("SWITCH FLUSH");
    });

    // The remounted panel shows the new task
    expect(screen.getByTestId("edit-panel-code")).toHaveTextContent("TSK-0003");
  });
});

// ── onOpenPage / onOpenDossier prop threading ─────────────────────────────────

describe("TaskingScreen — onOpenPage / onOpenDossier prop threading", () => {
  function renderScreenWithProps(
    onOpenPage: (path: string) => void,
    onOpenDossier: (link: string) => void,
  ) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <TaskingScreen onOpenPage={onOpenPage} onOpenDossier={onOpenDossier} />
      </QueryClientProvider>,
    );
  }

  it("OPEN PAGE → in TaskEditPanel calls onOpenPage with the task path", async () => {
    const onOpenPage = vi.fn();
    const onOpenDossier = vi.fn();
    stubBoardFetch();
    renderScreenWithProps(onOpenPage, onOpenDossier);
    await screen.findByText("TASKING BOARD");

    // Open the edit panel for t1
    useBoardStore.setState({ editTaskId: "t1" });
    await screen.findByTestId("edit-panel");

    await userEvent.click(screen.getByTestId("edit-panel-open-page"));
    // t1's path is "tasks/t1.md"
    expect(onOpenPage).toHaveBeenCalledWith("tasks/t1.md");
    expect(onOpenDossier).not.toHaveBeenCalled();
  });

  it("OPEN → dossier button in TaskEditPanel calls onOpenDossier with task.link", async () => {
    // Override fetch to return a fixture where t1 has a link field
    const boardWithLink = {
      ...BOARD_FIXTURE,
      tasks: BOARD_FIXTURE.tasks.map((t) =>
        t.id === "t1" ? { ...t, link: "ops-1" } : t,
      ),
    };
    const fetchStub = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(boardWithLink),
      } as Response),
    );
    vi.stubGlobal("fetch", fetchStub);

    const onOpenPage = vi.fn();
    const onOpenDossier = vi.fn();
    renderScreenWithProps(onOpenPage, onOpenDossier);
    await screen.findByText("TASKING BOARD");

    useBoardStore.setState({ editTaskId: "t1" });
    await screen.findByTestId("edit-panel");

    await userEvent.click(screen.getByTestId("edit-panel-open-dossier"));
    expect(onOpenDossier).toHaveBeenCalledWith("ops-1");
    expect(onOpenPage).not.toHaveBeenCalled();
  });

  it("op-meta DOSSIER button in BoardHeader calls onOpenDossier with the op dossier", async () => {
    const onOpenPage = vi.fn();
    const onOpenDossier = vi.fn();
    stubBoardFetch();
    renderScreenWithProps(onOpenPage, onOpenDossier);
    await screen.findByText("TASKING BOARD");

    // Select OPS-1 via its ScopeRail row → the op-meta line renders
    await userEvent.click(screen.getByText("OPS-1").closest("button")!);
    expect(useBoardStore.getState().opFilter).toBe("alpha");

    // The DOSSIER button shows the op's dossier value ("tasks/ops-1")
    await userEvent.click(screen.getByRole("button", { name: "tasks/ops-1" }));
    expect(onOpenDossier).toHaveBeenCalledWith("tasks/ops-1");
    expect(onOpenPage).not.toHaveBeenCalled();
  });
});

// ── filter strip: shared FilterBar composition ────────────────────────────────

describe("TaskingScreen — shared FilterBar composition", () => {
  it("offers neutral filter labels", async () => {
    stubBoardFetch();
    renderScreenWithFilter();
    await screen.findByText("TASKING BOARD");

    await userEvent.click(screen.getByTestId("filter-bar-add"));

    for (const label of ["Project", "Tags", "Priority", "Status", "Blocked"]) {
      expect(
        screen.getByRole("button", { name: label }),
      ).toBeInTheDocument();
    }
  });

  it("typing text filters visible cards and shows the N OF M count", async () => {
    stubBoardFetch(FILTER_FIXTURE);
    renderScreenWithFilter();
    await screen.findByText("TASKING BOARD");

    expect(screen.getByText("Alpha task")).toBeInTheDocument();
    expect(screen.getByText("Beta task")).toBeInTheDocument();
    expect(screen.getByText("Gamma task")).toBeInTheDocument();
    expect(screen.queryByTestId("filter-bar-count")).not.toBeInTheDocument();

    await userEvent.type(screen.getByTestId("filter-bar-input"), "alpha");

    expect(screen.getByText("Alpha task")).toBeInTheDocument();
    expect(screen.queryByText("Beta task")).not.toBeInTheDocument();
    expect(screen.queryByText("Gamma task")).not.toBeInTheDocument();
    expect(screen.getByTestId("filter-bar-count")).toHaveTextContent(
      "01 OF 03",
    );
  });

  it("adding a project facet chip narrows to that project's tasks", async () => {
    stubBoardFetch();
    renderScreenWithFilter();
    await screen.findByText("TASKING BOARD");

    expect(screen.getByText("Task Alpha 1")).toBeInTheDocument();
    expect(screen.getByText("Task Beta 1")).toBeInTheDocument();
    expect(screen.getByText("Task Unfiled")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("filter-bar-add"));
    await userEvent.click(screen.getByTestId("filter-bar-field-project"));
    await userEvent.click(
      screen.getByTestId("filter-bar-option-project-alpha"),
    );

    // t1, t2, t5 carry project="alpha"; t3 (beta) and t4 (unfiled) drop out
    expect(screen.getByText("Task Alpha 1")).toBeInTheDocument();
    expect(screen.getByText("Task Alpha 2")).toBeInTheDocument();
    expect(screen.getByText("Task Sealed")).toBeInTheDocument();
    expect(screen.queryByText("Task Beta 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Task Unfiled")).not.toBeInTheDocument();
    expect(screen.getByTestId("filter-bar-count")).toHaveTextContent(
      "03 OF 05",
    );
  });

  it("composes a project facet with the text filter", async () => {
    stubBoardFetch();
    renderScreenWithFilter();
    await screen.findByText("TASKING BOARD");

    await userEvent.click(screen.getByTestId("filter-bar-add"));
    await userEvent.click(screen.getByTestId("filter-bar-field-project"));
    await userEvent.click(
      screen.getByTestId("filter-bar-option-project-alpha"),
    );
    // Multi-select fields leave the popover open; close it explicitly so the
    // outside text input is interactable again (react-aria's overlay hides
    // outside content from interaction while a non-modal popover is open).
    await userEvent.click(screen.getByTestId("filter-bar-add"));
    await userEvent.type(screen.getByTestId("filter-bar-input"), "sealed");

    expect(screen.getByText("Task Sealed")).toBeInTheDocument();
    expect(screen.queryByText("Task Alpha 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Task Alpha 2")).not.toBeInTheDocument();
    expect(screen.getByTestId("filter-bar-count")).toHaveTextContent(
      "01 OF 05",
    );
  });

  it("clearing the filter restores all cards and hides the count line", async () => {
    stubBoardFetch(FILTER_FIXTURE);
    renderScreenWithFilter();
    await screen.findByText("TASKING BOARD");

    await userEvent.type(screen.getByTestId("filter-bar-input"), "alpha");
    expect(screen.queryByText("Beta task")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("filter-bar-clear"));

    expect(screen.getByText("Alpha task")).toBeInTheDocument();
    expect(screen.getByText("Beta task")).toBeInTheDocument();
    expect(screen.getByText("Gamma task")).toBeInTheDocument();
    expect(screen.queryByTestId("filter-bar-count")).not.toBeInTheDocument();
  });

  it("the hold flag shows only held tasks", async () => {
    // t2 in BOARD_FIXTURE carries hold="blocker"
    stubBoardFetch();
    renderScreenWithFilter();
    await screen.findByText("TASKING BOARD");

    await userEvent.click(screen.getByTestId("filter-bar-add"));
    await userEvent.click(screen.getByTestId("filter-bar-field-hold"));

    expect(screen.getByText("Task Alpha 2")).toBeInTheDocument();
    expect(screen.queryByText("Task Alpha 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Task Beta 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Task Unfiled")).not.toBeInTheDocument();
    expect(screen.queryByText("Task Sealed")).not.toBeInTheDocument();
    expect(screen.getByTestId("filter-bar-count")).toHaveTextContent(
      "01 OF 05",
    );
  });
});

// ── fixed human-facing status labels ──────────────────────────────────────────

describe("TaskingScreen — fixed human-facing status labels", () => {
  it("keeps FIELD displayed as In Progress when the server sends DEPLOYED", async () => {
    const relabeled: BoardResponse = {
      ...BOARD_FIXTURE,
      columns: BOARD_FIXTURE.columns.map((c) =>
        c.id === "FIELD" ? { ...c, label: "DEPLOYED" } : c,
      ),
    };
    useBoardStore.setState({ mode: "backlog" });
    stubBoardFetch(relabeled);
    renderScreen();
    await screen.findByText("TASKING BOARD");

    const row = screen.getByTestId("bk-row-t1");
    expect(within(row).getByText("In Progress")).toBeInTheDocument();
    expect(within(row).queryByText("DEPLOYED")).not.toBeInTheDocument();
  });

  it("uses the fixed FIELD label in the inline status popover", async () => {
    const relabeled: BoardResponse = {
      ...BOARD_FIXTURE,
      columns: BOARD_FIXTURE.columns.map((c) =>
        c.id === "FIELD" ? { ...c, label: "DEPLOYED" } : c,
      ),
    };
    useBoardStore.setState({ mode: "backlog" });
    stubBoardFetch(relabeled);
    renderScreen();
    await screen.findByText("TASKING BOARD");

    await userEvent.click(screen.getByTestId("bk-inline-status-t1"));

    const fieldOption = screen.getByTestId("inline-status-FIELD");
    const fieldLabel = fieldOption.closest("label");
    expect(fieldLabel).toHaveTextContent("In Progress");
    expect(fieldLabel).not.toHaveTextContent("DEPLOYED");
  });
});

// ── stale opFilter self-heal ──────────────────────────────────────────────────

describe("TaskingScreen — stale opFilter self-heal", () => {
  it("resets a persisted opFilter matching no operation to ALL once data loads", async () => {
    useBoardStore.setState({ opFilter: "ghost-op" });
    stubBoardFetch();
    renderScreen();
    await screen.findByText("TASKING BOARD");

    // The effect resets the stale filter to ALL…
    await waitFor(() => expect(useBoardStore.getState().opFilter).toBe("ALL"));
    // …and the full task set renders (would be empty under "ghost-op")
    expect(await screen.findByText("Task Alpha 1")).toBeInTheDocument();
    expect(screen.getByText("Task Unfiled")).toBeInTheDocument();
  });

  it("does not reset UNFILED or a valid op filter", async () => {
    useBoardStore.setState({ opFilter: "UNFILED" });
    stubBoardFetch();
    renderScreen();
    await screen.findByText("TASKING BOARD");
    expect(useBoardStore.getState().opFilter).toBe("UNFILED");

    act(() => useBoardStore.setState({ opFilter: "alpha" }));
    await waitFor(() =>
      expect(useBoardStore.getState().opFilter).toBe("alpha"),
    );
  });
});
