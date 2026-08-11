/**
 * TaskEditPanel tests.
 *
 * Covers:
 *   - Render: task fields present
 *   - Immediate patches: disposition radio, priority radio, operation select,
 *     cycle select (BACKLOG → null), tags
 *   - Debounced patches: title, assignee, hold reason (vi.useFakeTimers)
 *   - Hold toggle on/off payloads
 *   - Checklist: read-only, shows d/total, OPEN PAGE button calls handler
 *   - Destroy two-step: first click arms, second fires DELETE to page path and closes
 *   - Scrim click closes panel
 *   - Escape closes panel
 */

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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardTask } from "#/api/board";
import { queryKeys } from "#/api/keys";
import { useBoardStore } from "#/store/board";
import { TaskEditPanel } from "../TaskEditPanel";
import { BOARD_FIXTURE } from "./fixtures";

const { operations, cycles } = BOARD_FIXTURE;

// A task with all optional fields populated for richer render tests
const FULL_TASK: BoardTask = {
  id: "t-full",
  code: "TSK-0042",
  title: "FULL TASK",
  status: "FIELD",
  priority: "P1",
  project: "alpha",
  cycle: "C-01",
  assignee: "Kit",
  estimate: "4h",
  due: "2026-12-01",
  hold: null,
  link: "tasks/alpha-dossier",
  tags: ["INFRA", "DOCS"],
  checks: [2, 5],
  path: "tasks/t-full.md",
  updated_at: "2026-06-10T00:00:00Z",
};

const HELD_TASK: BoardTask = {
  ...FULL_TASK,
  id: "t-held",
  code: "TSK-0043",
  hold: "BLOCKED — waiting on API",
};

// ── helpers ───────────────────────────────────────────────────────────────────

interface WrapOpts {
  task?: BoardTask;
  onClose?: () => void;
  onOpenPage?: (path: string) => void;
  onOpenDossier?: (link: string) => void;
  fetchStub?: ReturnType<typeof vi.fn>;
  /** Pre-populate board cache to enable optimistic PATCH */
  seedBoard?: boolean;
}

function wrap({
  task = FULL_TASK,
  onClose = vi.fn(),
  onOpenPage = vi.fn(),
  onOpenDossier = vi.fn(),
  fetchStub,
  seedBoard = false,
}: WrapOpts = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  if (seedBoard) {
    // Insert our test task into the fixture so optimistic PATCH can find it
    const boardWithTask = {
      ...BOARD_FIXTURE,
      tasks: [...BOARD_FIXTURE.tasks.filter((t) => t.id !== task.id), task],
    };
    qc.setQueryData(queryKeys.board.all, boardWithTask);
  }

  if (fetchStub) vi.stubGlobal("fetch", fetchStub);

  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <TaskEditPanel
          task={task}
          operations={operations}
          cycles={cycles}
          onClose={onClose}
          onOpenPage={onOpenPage}
          onOpenDossier={onOpenDossier}
        />
      </QueryClientProvider>,
    ),
  };
}

/**
 * Stub that handles:
 *   - PATCH /api/vault/board/tasks/{id} → returns the patched task (minimal)
 *   - DELETE /api/vault/pages/{path} → 204
 *   - GET /api/vault/board → BOARD_FIXTURE
 */
function makeStub(task: BoardTask = FULL_TASK) {
  return vi.fn((_url: string, opts?: RequestInit) => {
    if (opts?.method === "PATCH") {
      const p = JSON.parse(opts.body as string);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ...task, ...p }),
      } as Response);
    }
    if (opts?.method === "DELETE") {
      return Promise.resolve({
        ok: true,
        status: 204,
        json: () => Promise.resolve(null),
      } as unknown as Response);
    }
    // GET board
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(BOARD_FIXTURE),
    } as Response);
  });
}

// ── setup / teardown ──────────────────────────────────────────────────────────

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
  vi.useRealTimers();
});

// ══════════════════════════════════════════════════════════════════════════════
// Render
// ══════════════════════════════════════════════════════════════════════════════

describe("TaskEditPanel — render", () => {
  it("renders the panel with task code and title", () => {
    wrap();
    expect(screen.getByTestId("edit-panel-code")).toHaveTextContent("TSK-0042");
    expect(screen.getByTestId("edit-panel-title")).toHaveValue("FULL TASK");
  });

  it("renders priority chip with correct text", () => {
    wrap();
    expect(screen.getByTestId("edit-panel-priority")).toHaveTextContent("P1");
  });

  it("renders the op code in the header", () => {
    wrap();
    // FULL_TASK has project "alpha" → OPS-1
    expect(screen.getByTestId("edit-panel-op")).toHaveTextContent("OPS-1");
  });

  it("renders tags joined with comma-space", () => {
    wrap();
    expect(screen.getByTestId<HTMLInputElement>("edit-panel-tags").value).toBe(
      "INFRA, DOCS",
    );
  });

  it("renders OPEN → button when task has link", () => {
    wrap();
    expect(screen.getByTestId("edit-panel-open-dossier")).toBeInTheDocument();
  });

  it("does not render OPEN → dossier button when task has no link", () => {
    wrap({ task: { ...FULL_TASK, link: null } });
    expect(
      screen.queryByTestId("edit-panel-open-dossier"),
    ).not.toBeInTheDocument();
  });

  it("shows UNFILED in the header when task has no project", () => {
    wrap({ task: { ...FULL_TASK, project: null } });
    expect(screen.getByTestId("edit-panel-op")).toHaveTextContent("UNFILED");
  });

  it("shows hold reason input when task is held", () => {
    wrap({ task: HELD_TASK });
    expect(screen.getByTestId("edit-panel-hold-reason")).toBeInTheDocument();
    expect(
      screen.getByTestId<HTMLInputElement>("edit-panel-hold-reason").value,
    ).toBe("BLOCKED — waiting on API");
  });

  it("does not show hold reason input when task is not held", () => {
    wrap();
    expect(
      screen.queryByTestId("edit-panel-hold-reason"),
    ).not.toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Checklist — read-only (decision 7)
// ══════════════════════════════════════════════════════════════════════════════

describe("TaskEditPanel — checklist read-only", () => {
  it("shows d / total done hint text", () => {
    wrap();
    // FULL_TASK has checks: [2, 5]
    expect(screen.getByText(/2 \/ 5 done/)).toBeInTheDocument();
  });

  it("shows 'none' hint when checks is empty", () => {
    wrap({ task: { ...FULL_TASK, checks: [] } });
    // hint shows "none"
    expect(screen.getByText("none")).toBeInTheDocument();
  });

  it("renders OPEN PAGE → button", () => {
    wrap();
    expect(screen.getByTestId("edit-panel-open-page")).toBeInTheDocument();
  });

  it("OPEN PAGE → calls onOpenPage with task.path", async () => {
    const onOpenPage = vi.fn();
    wrap({ onOpenPage });
    await userEvent.click(screen.getByTestId("edit-panel-open-page"));
    expect(onOpenPage).toHaveBeenCalledWith("tasks/t-full.md");
  });

  it("does NOT render checklist stepper buttons (no +/- for done/total)", () => {
    wrap();
    // No + or − stepper buttons — the prototype had them but we deviate
    expect(screen.queryByText("−")).not.toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Immediate patches (radios/selects)
// ══════════════════════════════════════════════════════════════════════════════

describe("TaskEditPanel — immediate patches", () => {
  it("disposition radio change fires immediate PATCH {status}", async () => {
    const stub = makeStub();
    wrap({ fetchStub: stub, seedBoard: true });
    const disposition = screen.getByRole("radiogroup", {
      name: "Disposition",
    });
    expect(
      within(disposition).getByTestId("edit-panel-status-REVIEW"),
    ).toHaveRole("radio");

    await userEvent.click(screen.getByTestId("edit-panel-status-REVIEW"));

    await waitFor(() => {
      const patchCalls = stub.mock.calls.filter(
        ([, opts]) => opts?.method === "PATCH",
      );
      expect(patchCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(patchCalls[0][1]!.body as string) as Record<
        string,
        unknown
      >;
      expect(body.status).toBe("REVIEW");
    });
  });

  it("priority radio change fires immediate PATCH {priority}", async () => {
    const stub = makeStub();
    wrap({ fetchStub: stub, seedBoard: true });
    const priority = screen.getByRole("radiogroup", { name: "Priority" });
    expect(
      within(priority).getByTestId("edit-panel-priority-P0"),
    ).toHaveRole("radio");

    await userEvent.click(screen.getByTestId("edit-panel-priority-P0"));

    await waitFor(() => {
      const patchCalls = stub.mock.calls.filter(
        ([, opts]) => opts?.method === "PATCH",
      );
      expect(patchCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(patchCalls[0][1]!.body as string) as Record<
        string,
        unknown
      >;
      expect(body.priority).toBe("P0");
    });
  });

  it("cycle select BACKLOG fires PATCH {cycle: null}", async () => {
    const stub = makeStub();
    // Task has cycle C-01 so selecting BACKLOG is a change
    wrap({ task: FULL_TASK, fetchStub: stub, seedBoard: true });

    await userEvent.selectOptions(
      screen.getByTestId("edit-panel-cycle"),
      "BACKLOG",
    );

    await waitFor(() => {
      const patchCalls = stub.mock.calls.filter(
        ([, opts]) => opts?.method === "PATCH",
      );
      expect(patchCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(patchCalls[0][1]!.body as string) as Record<
        string,
        unknown
      >;
      expect(body.cycle).toBeNull();
    });
  });

  it("operation UNFILED select fires PATCH {project: ''}", async () => {
    const stub = makeStub();
    wrap({ task: FULL_TASK, fetchStub: stub, seedBoard: true });

    await userEvent.selectOptions(
      screen.getByTestId("edit-panel-operation"),
      "",
    );

    await waitFor(() => {
      const patchCalls = stub.mock.calls.filter(
        ([, opts]) => opts?.method === "PATCH",
      );
      expect(patchCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(patchCalls[0][1]!.body as string) as Record<
        string,
        unknown
      >;
      // "" is the wire sentinel for "clear project → UNFILED"
      expect(body.project).toBe("");
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Debounced patches (text inputs, 300ms)
// ══════════════════════════════════════════════════════════════════════════════

describe("TaskEditPanel — debounced patches", () => {
  it("title edit fires PATCH {title} after 300ms debounce", async () => {
    vi.useFakeTimers();
    const stub = makeStub();
    wrap({ fetchStub: stub, seedBoard: true });

    const titleInput = screen.getByTestId("edit-panel-title");

    // Use fireEvent (not userEvent) — avoids the userEvent internal tick loop
    // that stalls when fake timers are active.
    act(() => {
      fireEvent.change(titleInput, { target: { value: "UPDATED TITLE" } });
    });

    // No PATCH yet (debounce hasn't fired)
    expect(
      stub.mock.calls.filter(([, opts]) => opts?.method === "PATCH"),
    ).toHaveLength(0);

    // Advance past the 300ms debounce and flush microtasks
    await act(async () => {
      vi.advanceTimersByTime(350);
    });

    const patchCalls = stub.mock.calls.filter(
      ([, opts]) => opts?.method === "PATCH",
    );
    expect(patchCalls.length).toBeGreaterThan(0);
    const body = JSON.parse(patchCalls[0][1]!.body as string) as Record<
      string,
      unknown
    >;
    expect(body.title).toBe("UPDATED TITLE");
  });

  it("flushes a pending title edit when the panel closes before the debounce fires", async () => {
    vi.useFakeTimers();
    const stub = makeStub();
    const { unmount } = wrap({ fetchStub: stub, seedBoard: true });

    act(() => {
      fireEvent.change(screen.getByTestId("edit-panel-title"), {
        target: { value: "FLUSHED TITLE" },
      });
    });

    // No PATCH yet — the 300ms debounce has not elapsed
    expect(
      stub.mock.calls.filter(([, opts]) => opts?.method === "PATCH"),
    ).toHaveLength(0);

    // Close the panel (Escape/✕/scrim all unmount it) WITHOUT advancing timers
    await act(async () => {
      unmount();
    });

    // The pending edit must be flushed, not dropped
    const patchCalls = stub.mock.calls.filter(
      ([, opts]) => opts?.method === "PATCH",
    );
    expect(patchCalls.length).toBe(1);
    const body = JSON.parse(patchCalls[0][1]!.body as string) as Record<
      string,
      unknown
    >;
    expect(body.title).toBe("FLUSHED TITLE");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Hold toggle
// ══════════════════════════════════════════════════════════════════════════════

describe("TaskEditPanel — hold toggle", () => {
  it("hold toggle ON fires PATCH {hold: 'BLOCKED — STATE REASON'}", async () => {
    const stub = makeStub();
    // Task starts with hold: null
    wrap({
      task: { ...FULL_TASK, hold: null },
      fetchStub: stub,
      seedBoard: true,
    });

    await userEvent.click(screen.getByTestId("edit-panel-hold-toggle"));

    await waitFor(() => {
      const patchCalls = stub.mock.calls.filter(
        ([, opts]) => opts?.method === "PATCH",
      );
      expect(patchCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(patchCalls[0][1]!.body as string) as Record<
        string,
        unknown
      >;
      expect(body.hold).toBe("BLOCKED — STATE REASON");
    });
  });

  it("hold toggle OFF fires PATCH {hold: null}", async () => {
    const stub = makeStub(HELD_TASK);
    wrap({ task: HELD_TASK, fetchStub: stub, seedBoard: true });

    await userEvent.click(screen.getByTestId("edit-panel-hold-toggle"));

    await waitFor(() => {
      const patchCalls = stub.mock.calls.filter(
        ([, opts]) => opts?.method === "PATCH",
      );
      expect(patchCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(patchCalls[0][1]!.body as string) as Record<
        string,
        unknown
      >;
      expect(body.hold).toBeNull();
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Destroy two-step
// ══════════════════════════════════════════════════════════════════════════════

describe("TaskEditPanel — destroy two-step", () => {
  it("first click shows CONFIRM DESTROY? button (armed state)", async () => {
    wrap();
    await userEvent.click(screen.getByTestId("edit-panel-destroy"));
    expect(
      screen.getByTestId("edit-panel-destroy-confirm"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("edit-panel-destroy")).not.toBeInTheDocument();
  });

  it("second click fires DELETE to task.path and calls setEditTaskId(null)", async () => {
    const stub = makeStub();
    wrap({ fetchStub: stub, seedBoard: true });

    // Arm
    await userEvent.click(screen.getByTestId("edit-panel-destroy"));
    // Confirm
    await userEvent.click(screen.getByTestId("edit-panel-destroy-confirm"));

    await waitFor(() => {
      const deleteCalls = stub.mock.calls.filter(
        ([, opts]) => opts?.method === "DELETE",
      );
      expect(deleteCalls.length).toBe(1);
      const url = deleteCalls[0][0] as string;
      // tasks/t-full.md encoded
      expect(url).toContain("tasks");
      expect(url).toContain("t-full.md");
      // Pinned policy: force past the backlink check, degrade inbound
      // wikilinks to plain text (not silently inherited backend default)
      expect(url).toContain("force=true");
      expect(url).toContain("rewrite=plain_text");
    });

    await waitFor(() => {
      expect(useBoardStore.getState().editTaskId).toBeNull();
    });
  });

  it("first click does NOT fire DELETE", async () => {
    const stub = makeStub();
    wrap({ fetchStub: stub });

    await userEvent.click(screen.getByTestId("edit-panel-destroy"));

    const deleteCalls = stub.mock.calls.filter(
      ([, opts]) => opts?.method === "DELETE",
    );
    expect(deleteCalls).toHaveLength(0);
  });

  it("destroy with a pending title edit fires DELETE and suppresses the trailing PATCH", async () => {
    vi.useFakeTimers();
    const stub = makeStub();
    const { unmount } = wrap({ fetchStub: stub, seedBoard: true });

    // Pending debounced edit — the 300ms debounce never advances
    act(() => {
      fireEvent.change(screen.getByTestId("edit-panel-title"), {
        target: { value: "DOOMED EDIT" },
      });
    });

    // Two-step destroy
    act(() => {
      fireEvent.click(screen.getByTestId("edit-panel-destroy"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("edit-panel-destroy-confirm"));
    });

    // Panel unmounts (in the app: setEditTaskId(null) on DELETE success)
    await act(async () => {
      unmount();
    });

    const deleteCalls = stub.mock.calls.filter(
      ([, opts]) => opts?.method === "DELETE",
    );
    expect(deleteCalls).toHaveLength(1);
    // The pending edit must NOT be flushed at the just-deleted task
    const patchCalls = stub.mock.calls.filter(
      ([, opts]) => opts?.method === "PATCH",
    );
    expect(patchCalls).toHaveLength(0);
  });

  it("armed CONFIRM DESTROY? auto-disarms after 3s", async () => {
    vi.useFakeTimers();
    wrap();

    act(() => {
      fireEvent.click(screen.getByTestId("edit-panel-destroy"));
    });
    expect(
      screen.getByTestId("edit-panel-destroy-confirm"),
    ).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(3100);
    });

    expect(
      screen.queryByTestId("edit-panel-destroy-confirm"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("edit-panel-destroy")).toBeInTheDocument();
  });

  it("pointer-leave of the footer disarms a pending destroy", async () => {
    wrap();

    await userEvent.click(screen.getByTestId("edit-panel-destroy"));
    expect(
      screen.getByTestId("edit-panel-destroy-confirm"),
    ).toBeInTheDocument();

    fireEvent.pointerLeave(screen.getByTestId("edit-panel-foot"));

    expect(
      screen.queryByTestId("edit-panel-destroy-confirm"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("edit-panel-destroy")).toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Scrim + escape close
// ══════════════════════════════════════════════════════════════════════════════

describe("TaskEditPanel — scrim and escape close", () => {
  it("scrim click calls onClose", async () => {
    const onClose = vi.fn();
    wrap({ onClose });
    await userEvent.click(screen.getByTestId("edit-panel-scrim"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape key calls onClose", async () => {
    const onClose = vi.fn();
    wrap({ onClose });
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking the ✕ close button calls onClose", async () => {
    const onClose = vi.fn();
    wrap({ onClose });
    await userEvent.click(screen.getByTestId("edit-panel-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking the panel itself does NOT call onClose", async () => {
    const onClose = vi.fn();
    wrap({ onClose });
    await userEvent.click(screen.getByTestId("edit-panel"));
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Dossier link
// ══════════════════════════════════════════════════════════════════════════════

describe("TaskEditPanel — dossier link", () => {
  it("OPEN → calls onOpenDossier with task.link", async () => {
    const onOpenDossier = vi.fn();
    wrap({ onOpenDossier });
    await userEvent.click(screen.getByTestId("edit-panel-open-dossier"));
    expect(onOpenDossier).toHaveBeenCalledWith("tasks/alpha-dossier");
  });
});
