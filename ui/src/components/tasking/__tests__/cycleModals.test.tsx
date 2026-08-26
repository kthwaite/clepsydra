/**
 * Cycle lifecycle modals tests.
 *
 * Covers:
 *  - newCyclePrefill pure helper (unit)
 *  - sealStats pure helper (unit)
 *  - NewCycleModal: render, prefill, ⌘↵, success callbacks, ESC
 *  - OpenCycleModal: stats, callouts (empty / clash), PATCH payload, ESC
 *  - SealCycleModal: stats, carryover radios, payloads, clean-close, ESC
 *  - TaskingScreen integration: mounts each modal by cycleModal state
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardCycle, BoardTask } from "#/api/board";
import { isoAddDays } from "#/lib/time";
import { useBoardStore } from "#/store/board";
import { sealStats } from "../board-stats";
import { NewCycleModal, newCyclePrefill } from "../NewCycleModal";
import { OpenCycleModal } from "../OpenCycleModal";
import { SealCycleModal } from "../SealCycleModal";
import { TaskingScreen } from "../TaskingScreen";
import { BOARD_FIXTURE, stubBoardFetch } from "./fixtures";

// ── fixtures ──────────────────────────────────────────────────────────────────

const NOW = "2026-06-11";

const CYCLE_ACTIVE: BoardCycle = {
  id: "cyc-111",
  code: "C-01",
  label: "Cycle 01",
  state: "ACTIVE",
  path: "tasks/c-01.md",
  start: "2026-05-26",
  end: "2026-06-08",
  goal: "Ship the board shell.",
};

const CYCLE_PLANNED: BoardCycle = {
  id: "cyc-222",
  code: "C-02",
  label: "Cycle 02",
  state: "PLANNED",
  path: "tasks/c-02.md",
  start: "2026-06-09",
  end: "2026-06-22",
  goal: null,
};

const CYCLE_PLANNED_2: BoardCycle = {
  id: "cyc-333",
  code: "S-03",
  label: "Cycle 03",
  state: "PLANNED",
  path: "tasks/s-03.md",
  start: "2026-06-23",
  end: "2026-07-06",
  goal: "Next cycle.",
};

const TASKS: BoardTask[] = [
  {
    id: "t1",
    code: "TSK-0001",
    title: "Alpha",
    body_excerpt: null,
    status: "FIELD",
    priority: "P1",
    project: "alpha",
    cycle: "C-01",
    tags: [],
    checks: [0, 3],
    path: "tasks/t1.md",
    updated_at: "2026-06-01T00:00:00Z",
  },
  {
    id: "t2",
    code: "TSK-0002",
    title: "Beta",
    body_excerpt: null,
    status: "SEALED",
    priority: "P2",
    project: "alpha",
    cycle: "C-01",
    tags: [],
    checks: [2, 2],
    path: "tasks/t2.md",
    updated_at: "2026-06-02T00:00:00Z",
  },
  {
    id: "t3",
    code: "TSK-0003",
    title: "Gamma",
    body_excerpt: null,
    status: "INTAKE",
    priority: "P3",
    project: null,
    cycle: "C-02",
    tags: [],
    checks: [],
    path: "tasks/t3.md",
    updated_at: "2026-06-03T00:00:00Z",
  },
];

// ── helpers ───────────────────────────────────────────────────────────────────

function wrapQC(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

function makePatchStub(result: object = CYCLE_ACTIVE) {
  return vi.fn((_url: string, opts?: RequestInit) => {
    if (opts?.method === "PATCH") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(result),
      } as Response);
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(BOARD_FIXTURE),
    } as Response);
  });
}

function makeCreateStub(result: BoardCycle = CYCLE_ACTIVE) {
  return vi.fn((_url: string, opts?: RequestInit) => {
    if (opts?.method === "POST") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(result),
      } as Response);
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(BOARD_FIXTURE),
    } as Response);
  });
}

// ── setup/teardown ────────────────────────────────────────────────────────────

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
// newCyclePrefill — pure unit tests
// ══════════════════════════════════════════════════════════════════════════════

describe("newCyclePrefill", () => {
  it("code S-1 and label CYCLE 1 when no existing cycles", () => {
    const pf = newCyclePrefill([], NOW);
    expect(pf.code).toBe("S-1");
    expect(pf.label).toBe("CYCLE 1");
  });

  it("increments from max numeric suffix (S-1 exists → S-2)", () => {
    const pf = newCyclePrefill([{ code: "S-1", end: "2026-06-10" }], NOW);
    expect(pf.code).toBe("S-2");
  });

  it("handles codes with leading zeros (C-01 → S-2)", () => {
    const pf = newCyclePrefill(
      [
        { code: "C-01", end: "2026-06-08" },
        { code: "C-02", end: "2026-06-22" },
      ],
      NOW,
    );
    expect(pf.code).toBe("S-3");
  });

  it("start = day after latest cycle end (not now)", () => {
    const pf = newCyclePrefill(
      [
        { code: "C-01", end: "2026-06-08" },
        { code: "C-02", end: "2026-06-22" },
      ],
      NOW,
    );
    expect(pf.start).toBe("2026-06-23");
  });

  it("end = start + 6 days", () => {
    const pf = newCyclePrefill([{ code: "S-1", end: "2026-06-10" }], NOW);
    expect(pf.end).toBe(isoAddDays(pf.start, 6));
  });

  it("falls back to now when no cycle has an end date", () => {
    const pf = newCyclePrefill([{ code: "S-1", end: null }], NOW);
    // start = now + 1 day (since lastEnd falls back to now)
    expect(pf.start).toBe(isoAddDays(NOW, 1));
  });

  it("falls back to now when cycles array is empty", () => {
    const pf = newCyclePrefill([], NOW);
    expect(pf.start).toBe(isoAddDays(NOW, 1));
  });

  it("single cycle: code increments by 1", () => {
    const pf = newCyclePrefill([{ code: "S-5", end: "2026-07-01" }], NOW);
    expect(pf.code).toBe("S-6");
    expect(pf.label).toBe("CYCLE 6");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// sealStats — pure unit tests
// ══════════════════════════════════════════════════════════════════════════════

describe("sealStats", () => {
  it("committed = tasks in the given cycle", () => {
    const stats = sealStats(TASKS, "C-01");
    expect(stats.committed).toBe(2);
  });

  it("sealed = tasks with status SEALED", () => {
    const stats = sealStats(TASKS, "C-01");
    expect(stats.sealed).toBe(1);
  });

  it("carryover = committed - sealed", () => {
    const stats = sealStats(TASKS, "C-01");
    expect(stats.carryover).toBe(1);
  });

  it("pct = round((sealed / committed) * 100)", () => {
    const stats = sealStats(TASKS, "C-01");
    expect(stats.pct).toBe(50);
  });

  it("pct = 0 when no committed tasks", () => {
    const stats = sealStats(TASKS, "GHOST");
    expect(stats.pct).toBe(0);
    expect(stats.committed).toBe(0);
    expect(stats.carryover).toBe(0);
  });

  it("pct = 100 when all tasks sealed", () => {
    const allSealed: BoardTask[] = [
      { ...TASKS[0], cycle: "X-01", status: "SEALED" },
      { ...TASKS[1], cycle: "X-01", status: "SEALED" },
    ];
    const stats = sealStats(allSealed, "X-01");
    expect(stats.pct).toBe(100);
    expect(stats.carryover).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// NewCycleModal
// ══════════════════════════════════════════════════════════════════════════════

describe("NewCycleModal — render", () => {
  it("renders nothing when cycleModal is null", () => {
    wrapQC(<NewCycleModal cycles={BOARD_FIXTURE.cycles} now={NOW} />);
    expect(screen.queryByTestId("new-cycle-modal")).not.toBeInTheDocument();
  });

  it("renders nothing when cycleModal.kind is not 'new'", () => {
    useBoardStore.setState({
      cycleModal: { kind: "open", cycleId: "cyc-111" },
    });
    wrapQC(<NewCycleModal cycles={BOARD_FIXTURE.cycles} now={NOW} />);
    expect(screen.queryByTestId("new-cycle-modal")).not.toBeInTheDocument();
  });

  it("shows the creation title, fields, action, and goal placeholder", () => {
    useBoardStore.setState({ cycleModal: { kind: "new" } });
    wrapQC(<NewCycleModal cycles={BOARD_FIXTURE.cycles} now={NOW} />);

    expect(
      screen.getByRole("dialog", { name: "New cycle" }),
    ).toBeInTheDocument();
    expect(screen.getByText("New cycle")).toBeInTheDocument();
    for (const field of [
      "Name",
      "ID",
      "Start date",
      "End date",
      "Status",
      "Goal",
    ]) {
      expect(screen.getByText(field, { exact: true })).toBeInTheDocument();
    }
    for (const field of ["Name", "ID", "Start date", "End date", "Goal"]) {
      expect(screen.getByLabelText(field, { exact: true })).toBeInTheDocument();
    }
    expect(
      screen.getByRole("group", { name: "Status" }),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("What this cycle should achieve"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create cycle" }),
    ).toBeInTheDocument();
  });

  it("prefills label with CYCLE N", () => {
    useBoardStore.setState({ cycleModal: { kind: "new" } });
    wrapQC(<NewCycleModal cycles={[CYCLE_ACTIVE, CYCLE_PLANNED]} now={NOW} />);
    const label = screen.getByTestId<HTMLInputElement>("new-cycle-label");
    // cycles have suffix 1 and 2 → next is 3
    expect(label.value).toBe("CYCLE 3");
  });

  it("prefills code with S-N", () => {
    useBoardStore.setState({ cycleModal: { kind: "new" } });
    wrapQC(<NewCycleModal cycles={[CYCLE_ACTIVE, CYCLE_PLANNED]} now={NOW} />);
    const code = screen.getByTestId<HTMLInputElement>("new-cycle-code");
    expect(code.value).toBe("S-3");
  });

  it("prefills start as day after latest cycle end", () => {
    useBoardStore.setState({ cycleModal: { kind: "new" } });
    wrapQC(<NewCycleModal cycles={[CYCLE_ACTIVE, CYCLE_PLANNED]} now={NOW} />);
    // CYCLE_PLANNED.end = 2026-06-22 → start = 2026-06-23
    const start = screen.getByTestId<HTMLInputElement>("new-cycle-start");
    expect(start.value).toBe("2026-06-23");
  });

  it("prefills end as start + 6 days", () => {
    useBoardStore.setState({ cycleModal: { kind: "new" } });
    wrapQC(<NewCycleModal cycles={[CYCLE_ACTIVE, CYCLE_PLANNED]} now={NOW} />);
    const end = screen.getByTestId<HTMLInputElement>("new-cycle-end");
    expect(end.value).toBe("2026-06-29");
  });

  it("defaults INITIAL STATE to PLANNED", () => {
    useBoardStore.setState({ cycleModal: { kind: "new" } });
    wrapQC(<NewCycleModal cycles={[]} now={NOW} />);
    const planned = screen.getByTestId("new-cycle-state-PLANNED");
    expect(planned.className).toContain("bg-[var(--ink)]");
  });
  it("shows only the formatted cycle window in the sub-header", () => {
    useBoardStore.setState({ cycleModal: { kind: "new" } });
    wrapQC(<NewCycleModal cycles={[]} now={NOW} />);
    expect(screen.getByText("06.12 — 06.18")).toBeInTheDocument();
    expect(screen.queryByText(/cadence window/i)).not.toBeInTheDocument();
  });
});

describe("NewCycleModal — submit payload", () => {
  it("commits POST with code, label, start, end, state", async () => {
    const stub = makeCreateStub();
    vi.stubGlobal("fetch", stub);
    useBoardStore.setState({ cycleModal: { kind: "new" } });
    wrapQC(<NewCycleModal cycles={[CYCLE_ACTIVE, CYCLE_PLANNED]} now={NOW} />);

    await userEvent.click(screen.getByTestId("new-cycle-commit"));

    await waitFor(() => {
      const postCalls = stub.mock.calls.filter(
        ([, opts]) => (opts as RequestInit)?.method === "POST",
      );
      expect(postCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(
        (postCalls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body.code).toBe("S-3");
      expect(body.label).toBe("CYCLE 3");
      expect(body.start).toBe("2026-06-23");
      expect(body.end).toBe("2026-06-29");
      expect(body.state).toBe("PLANNED");
    });
  });

  it("shows Creating… while the request is pending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    useBoardStore.setState({ cycleModal: { kind: "new" } });
    wrapQC(<NewCycleModal cycles={[]} now={NOW} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Create cycle" }),
    );

    expect(
      await screen.findByRole("button", { name: "Creating…" }),
    ).toBeDisabled();
  });

  it("includes goal when filled in", async () => {
    const stub = makeCreateStub();
    vi.stubGlobal("fetch", stub);
    useBoardStore.setState({ cycleModal: { kind: "new" } });
    wrapQC(<NewCycleModal cycles={[]} now={NOW} />);

    await userEvent.type(
      screen.getByTestId("new-cycle-goal"),
      "finish the board",
    );
    await userEvent.click(screen.getByTestId("new-cycle-commit"));

    await waitFor(() => {
      const postCalls = stub.mock.calls.filter(
        ([, opts]) => (opts as RequestInit)?.method === "POST",
      );
      const body = JSON.parse(
        (postCalls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body.goal).toBe("finish the board");
    });
  });

  it("omits goal when left empty", async () => {
    const stub = makeCreateStub();
    vi.stubGlobal("fetch", stub);
    useBoardStore.setState({ cycleModal: { kind: "new" } });
    wrapQC(<NewCycleModal cycles={[]} now={NOW} />);

    await userEvent.click(screen.getByTestId("new-cycle-commit"));

    await waitFor(() => {
      const postCalls = stub.mock.calls.filter(
        ([, opts]) => (opts as RequestInit)?.method === "POST",
      );
      const body = JSON.parse(
        (postCalls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body.goal).toBeUndefined();
    });
  });

  it("⌘↵ commits the form", async () => {
    const stub = makeCreateStub();
    vi.stubGlobal("fetch", stub);
    useBoardStore.setState({ cycleModal: { kind: "new" } });
    wrapQC(<NewCycleModal cycles={[]} now={NOW} />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId("new-cycle-label"));
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    await waitFor(() => {
      const postCalls = stub.mock.calls.filter(
        ([, opts]) => (opts as RequestInit)?.method === "POST",
      );
      expect(postCalls.length).toBe(1);
    });
  });
});

describe("NewCycleModal — success callbacks", () => {
  it("on success: closes modal, sets cycleSel to new code, sets mode cycle", async () => {
    const newCycle: BoardCycle = {
      ...CYCLE_ACTIVE,
      code: "S-3",
      label: "CYCLE 3",
    };
    const stub = makeCreateStub(newCycle);
    vi.stubGlobal("fetch", stub);
    useBoardStore.setState({ cycleModal: { kind: "new" } });
    wrapQC(<NewCycleModal cycles={[CYCLE_ACTIVE, CYCLE_PLANNED]} now={NOW} />);

    await userEvent.click(screen.getByTestId("new-cycle-commit"));

    await waitFor(() => {
      expect(useBoardStore.getState().cycleModal).toBeNull();
      expect(useBoardStore.getState().cycleSel).toBe("S-3");
      expect(useBoardStore.getState().mode).toBe("cycle");
    });
  });
});

describe("NewCycleModal — close behaviour", () => {
  it("ESC closes without POST", async () => {
    const stub = makeCreateStub();
    vi.stubGlobal("fetch", stub);
    useBoardStore.setState({ cycleModal: { kind: "new" } });
    wrapQC(<NewCycleModal cycles={[]} now={NOW} />);

    await userEvent.keyboard("{Escape}");

    expect(useBoardStore.getState().cycleModal).toBeNull();
    const postCalls = stub.mock.calls.filter(
      ([, opts]) => (opts as RequestInit)?.method === "POST",
    );
    expect(postCalls).toHaveLength(0);
  });

  it("CANCEL button closes without POST", async () => {
    const stub = makeCreateStub();
    vi.stubGlobal("fetch", stub);
    useBoardStore.setState({ cycleModal: { kind: "new" } });
    wrapQC(<NewCycleModal cycles={[]} now={NOW} />);

    await userEvent.click(screen.getByTestId("new-cycle-cancel"));

    expect(useBoardStore.getState().cycleModal).toBeNull();
    const postCalls = stub.mock.calls.filter(
      ([, opts]) => (opts as RequestInit)?.method === "POST",
    );
    expect(postCalls).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// OpenCycleModal
// ══════════════════════════════════════════════════════════════════════════════

describe("OpenCycleModal — render", () => {
  it("renders nothing when cycleModal is null", () => {
    wrapQC(<OpenCycleModal cycle={CYCLE_PLANNED} cycles={[]} tasks={[]} />);
    expect(screen.queryByTestId("open-cycle-modal")).not.toBeInTheDocument();
  });

  it("shows the activation title, target state, and action", () => {
    useBoardStore.setState({
      cycleModal: { kind: "open", cycleId: "cyc-222" },
    });
    wrapQC(<OpenCycleModal cycle={CYCLE_PLANNED} cycles={[]} tasks={[]} />);

    expect(
      screen.getByRole("dialog", { name: "Start cycle" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Start cycle")).toHaveLength(2);
    expect(screen.getByText("Target state")).toBeInTheDocument();
    expect(screen.getByTestId("open-cycle-state")).toHaveTextContent("Active");
    expect(
      screen.getByRole("button", { name: "Start cycle" }),
    ).toBeInTheDocument();
  });

  it("shows cycle label", () => {
    useBoardStore.setState({
      cycleModal: { kind: "open", cycleId: "cyc-222" },
    });
    wrapQC(<OpenCycleModal cycle={CYCLE_PLANNED} cycles={[]} tasks={[]} />);
    expect(screen.getByTestId("open-cycle-label")).toHaveTextContent(
      "Cycle 02",
    );
  });

  it("shows Tasks count from cycle tasks", () => {
    useBoardStore.setState({
      cycleModal: { kind: "open", cycleId: "cyc-222" },
    });
    wrapQC(<OpenCycleModal cycle={CYCLE_PLANNED} cycles={[]} tasks={TASKS} />);
    // t3 has cycle "C-02"
    expect(screen.getByText("Tasks", { exact: true })).toBeInTheDocument();
    expect(screen.getByTestId("open-cycle-committed")).toHaveTextContent("01");
  });

  it("shows Checklist items total from cycle tasks", () => {
    useBoardStore.setState({
      cycleModal: { kind: "open", cycleId: "cyc-111" },
    });
    wrapQC(<OpenCycleModal cycle={CYCLE_ACTIVE} cycles={[]} tasks={TASKS} />);
    // t1: checks [0,3], t2: checks [2,2] → total = 5
    expect(
      screen.getByText("Checklist items", { exact: true }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("open-cycle-checks")).toHaveTextContent("05");
  });

  it("shows the target state as Active in cool colour", () => {
    useBoardStore.setState({
      cycleModal: { kind: "open", cycleId: "cyc-222" },
    });
    wrapQC(<OpenCycleModal cycle={CYCLE_PLANNED} cycles={[]} tasks={[]} />);
    expect(screen.getByTestId("open-cycle-state")).toHaveTextContent("Active");
  });

  it("shows exact empty-cycle guidance when there are no tasks", () => {
    useBoardStore.setState({
      cycleModal: { kind: "open", cycleId: "cyc-222" },
    });
    wrapQC(<OpenCycleModal cycle={CYCLE_PLANNED} cycles={[]} tasks={[]} />);
    expect(screen.getByTestId("open-cycle-empty-callout")).toHaveTextContent(
      "No tasks in this cycle. It will start empty; you can add tasks after starting it.",
    );
  });

  it("does NOT show empty-cycle callout when the cycle has tasks", () => {
    useBoardStore.setState({
      cycleModal: { kind: "open", cycleId: "cyc-222" },
    });
    wrapQC(<OpenCycleModal cycle={CYCLE_PLANNED} cycles={[]} tasks={TASKS} />);
    // t3 in C-02
    expect(
      screen.queryByTestId("open-cycle-empty-callout"),
    ).not.toBeInTheDocument();
  });

  it("shows exact guidance when another cycle is Active", () => {
    useBoardStore.setState({
      cycleModal: { kind: "open", cycleId: "cyc-222" },
    });
    wrapQC(
      <OpenCycleModal
        cycle={CYCLE_PLANNED}
        cycles={[CYCLE_ACTIVE]}
        tasks={[]}
      />,
    );
    expect(screen.getByTestId("open-cycle-clash-callout")).toHaveTextContent(
      "C-01 is already Active. Starting this cycle will leave two active cycles. Close C-01 first if that is not intended.",
    );
  });

  it("does NOT show clash callout when no other cycle is ACTIVE", () => {
    useBoardStore.setState({
      cycleModal: { kind: "open", cycleId: "cyc-222" },
    });
    wrapQC(
      <OpenCycleModal
        cycle={CYCLE_PLANNED}
        cycles={[CYCLE_PLANNED_2]}
        tasks={[]}
      />,
    );
    expect(
      screen.queryByTestId("open-cycle-clash-callout"),
    ).not.toBeInTheDocument();
  });
});

describe("OpenCycleModal — submit payload", () => {
  it("sends PATCH { state: 'ACTIVE' }", async () => {
    const stub = makePatchStub({ ...CYCLE_PLANNED, state: "ACTIVE" });
    vi.stubGlobal("fetch", stub);
    useBoardStore.setState({
      cycleModal: { kind: "open", cycleId: "cyc-222" },
    });
    wrapQC(<OpenCycleModal cycle={CYCLE_PLANNED} cycles={[]} tasks={[]} />);

    await userEvent.click(screen.getByTestId("open-cycle-commit"));

    await waitFor(() => {
      const patchCalls = stub.mock.calls.filter(
        ([, opts]) => (opts as RequestInit)?.method === "PATCH",
      );
      expect(patchCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(
        (patchCalls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body.state).toBe("ACTIVE");
    });
  });

  it("shows Starting… while the request is pending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    useBoardStore.setState({
      cycleModal: { kind: "open", cycleId: "cyc-222" },
    });
    wrapQC(<OpenCycleModal cycle={CYCLE_PLANNED} cycles={[]} tasks={[]} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Start cycle" }),
    );

    expect(
      await screen.findByRole("button", { name: "Starting…" }),
    ).toBeDisabled();
  });

  it("on success: closes modal and sets cycleSel to cycle code", async () => {
    const stub = makePatchStub({ ...CYCLE_PLANNED, state: "ACTIVE" });
    vi.stubGlobal("fetch", stub);
    useBoardStore.setState({
      cycleModal: { kind: "open", cycleId: "cyc-222" },
    });
    wrapQC(<OpenCycleModal cycle={CYCLE_PLANNED} cycles={[]} tasks={[]} />);

    await userEvent.click(screen.getByTestId("open-cycle-commit"));

    await waitFor(() => {
      expect(useBoardStore.getState().cycleModal).toBeNull();
      expect(useBoardStore.getState().cycleSel).toBe("C-02");
    });
  });
});

describe("OpenCycleModal — close behaviour", () => {
  it("ESC closes without PATCH", async () => {
    const stub = makePatchStub();
    vi.stubGlobal("fetch", stub);
    useBoardStore.setState({
      cycleModal: { kind: "open", cycleId: "cyc-222" },
    });
    wrapQC(<OpenCycleModal cycle={CYCLE_PLANNED} cycles={[]} tasks={[]} />);

    await userEvent.keyboard("{Escape}");

    expect(useBoardStore.getState().cycleModal).toBeNull();
    const patchCalls = stub.mock.calls.filter(
      ([, opts]) => (opts as RequestInit)?.method === "PATCH",
    );
    expect(patchCalls).toHaveLength(0);
  });

  it("CANCEL button closes without PATCH", async () => {
    const stub = makePatchStub();
    vi.stubGlobal("fetch", stub);
    useBoardStore.setState({
      cycleModal: { kind: "open", cycleId: "cyc-222" },
    });
    wrapQC(<OpenCycleModal cycle={CYCLE_PLANNED} cycles={[]} tasks={[]} />);

    await userEvent.click(screen.getByTestId("open-cycle-cancel"));

    expect(useBoardStore.getState().cycleModal).toBeNull();
    const patchCalls = stub.mock.calls.filter(
      ([, opts]) => (opts as RequestInit)?.method === "PATCH",
    );
    expect(patchCalls).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SealCycleModal
// ══════════════════════════════════════════════════════════════════════════════

describe("SealCycleModal — render", () => {
  it("renders nothing when cycleModal is null", () => {
    wrapQC(<SealCycleModal cycle={CYCLE_ACTIVE} cycles={[]} tasks={[]} />);
    expect(screen.queryByTestId("seal-cycle-modal")).not.toBeInTheDocument();
  });

  it("shows the closure title, action, and destination state", () => {
    useBoardStore.setState({
      cycleModal: { kind: "seal", cycleId: "cyc-111" },
    });
    wrapQC(<SealCycleModal cycle={CYCLE_ACTIVE} cycles={[]} tasks={[]} />);

    expect(
      screen.getByRole("dialog", { name: "Close cycle" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Close cycle")).toHaveLength(2);
    expect(screen.getByText("C-01 → Closed")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Close cycle" }),
    ).toBeInTheDocument();
  });

  it("shows cycle label", () => {
    useBoardStore.setState({
      cycleModal: { kind: "seal", cycleId: "cyc-111" },
    });
    wrapQC(<SealCycleModal cycle={CYCLE_ACTIVE} cycles={[]} tasks={[]} />);
    expect(screen.getByTestId("seal-cycle-label")).toHaveTextContent(
      "Cycle 01",
    );
  });

  it("shows Tasks / Done / Incomplete tasks / Completion metrics", () => {
    useBoardStore.setState({
      cycleModal: { kind: "seal", cycleId: "cyc-111" },
    });
    wrapQC(<SealCycleModal cycle={CYCLE_ACTIVE} cycles={[]} tasks={TASKS} />);
    // C-01: t1 (FIELD), t2 (SEALED) → tasks=2, done=1, incomplete=1, 50%
    expect(screen.getByText("Tasks", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Done", { exact: true })).toBeInTheDocument();
    expect(screen.getAllByText("Incomplete tasks")).toHaveLength(2);
    expect(screen.getByText("Completion", { exact: true })).toBeInTheDocument();
    expect(screen.getByTestId("seal-cycle-committed")).toHaveTextContent("02");
    expect(screen.getByTestId("seal-cycle-sealed")).toHaveTextContent("01");
    expect(screen.getByTestId("seal-cycle-carryover")).toHaveTextContent("01");
    expect(screen.getByTestId("seal-cycle-rate")).toHaveTextContent("50%");
  });

  it("shows clean-close callout when carryover = 0", () => {
    const allSealed: BoardTask[] = [
      { ...TASKS[0], cycle: "C-01", status: "SEALED" },
      { ...TASKS[1], cycle: "C-01", status: "SEALED" },
    ];
    useBoardStore.setState({
      cycleModal: { kind: "seal", cycleId: "cyc-111" },
    });
    wrapQC(
      <SealCycleModal cycle={CYCLE_ACTIVE} cycles={[]} tasks={allSealed} />,
    );
    expect(screen.getByTestId("seal-cycle-clean-callout")).toHaveTextContent(
      "All tasks are done. This cycle is ready to close.",
    );
    // No carry opts when clean
    expect(
      screen.queryByTestId("seal-cycle-carry-opts"),
    ).not.toBeInTheDocument();
  });

  it("shows incomplete-task movement choices when tasks remain", () => {
    useBoardStore.setState({
      cycleModal: { kind: "seal", cycleId: "cyc-111" },
    });
    wrapQC(
      <SealCycleModal
        cycle={CYCLE_ACTIVE}
        cycles={[CYCLE_PLANNED]}
        tasks={TASKS}
      />,
    );

    expect(screen.getAllByText("Incomplete tasks")).toHaveLength(2);
    expect(
      screen.getByRole("group", { name: "Incomplete tasks" }),
    ).toBeInTheDocument();
    for (const choice of [
      "Move to Backlog",
      `Move to ${CYCLE_PLANNED.code}`,
      "Keep in this cycle",
    ]) {
      expect(
        screen.getByRole("button", { name: choice }),
      ).toBeInTheDocument();
    }
  });

  it("shows next PLANNED cycle option when one exists", () => {
    useBoardStore.setState({
      cycleModal: { kind: "seal", cycleId: "cyc-111" },
    });
    wrapQC(
      <SealCycleModal
        cycle={CYCLE_ACTIVE}
        cycles={[CYCLE_PLANNED]}
        tasks={TASKS}
      />,
    );
    expect(
      screen.getByTestId(`seal-cycle-carry-${CYCLE_PLANNED.code}`),
    ).toBeInTheDocument();
  });

  it("shows next PLANNED cycle option when one exists (different id)", () => {
    useBoardStore.setState({
      cycleModal: { kind: "seal", cycleId: "cyc-111" },
    });
    wrapQC(
      <SealCycleModal
        cycle={CYCLE_ACTIVE}
        cycles={[CYCLE_PLANNED_2]} // PLANNED_2 is PLANNED and a different id from CYCLE_ACTIVE
        tasks={TASKS}
      />,
    );
    // PLANNED_2 is PLANNED and different id — should appear as a carry-to option
    expect(
      screen.getByTestId(`seal-cycle-carry-${CYCLE_PLANNED_2.code}`),
    ).toBeInTheDocument();
  });

  it("BACKLOG is selected by default", () => {
    useBoardStore.setState({
      cycleModal: { kind: "seal", cycleId: "cyc-111" },
    });
    wrapQC(<SealCycleModal cycle={CYCLE_ACTIVE} cycles={[]} tasks={TASKS} />);
    const backlog = screen.getByTestId("seal-cycle-carry-BACKLOG");
    expect(backlog.className).toContain("bg-[var(--ink)]");
  });
});

describe("SealCycleModal — submit payloads", () => {
  it("sends PATCH { state:'CLOSED', carry_to:'BACKLOG' } when BACKLOG selected", async () => {
    const stub = makePatchStub({ ...CYCLE_ACTIVE, state: "CLOSED" });
    vi.stubGlobal("fetch", stub);
    useBoardStore.setState({
      cycleModal: { kind: "seal", cycleId: "cyc-111" },
    });
    wrapQC(<SealCycleModal cycle={CYCLE_ACTIVE} cycles={[]} tasks={TASKS} />);

    // BACKLOG is default
    await userEvent.click(screen.getByTestId("seal-cycle-commit"));

    await waitFor(() => {
      const patchCalls = stub.mock.calls.filter(
        ([, opts]) => (opts as RequestInit)?.method === "PATCH",
      );
      expect(patchCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(
        (patchCalls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body.state).toBe("CLOSED");
      expect(body.carry_to).toBe("BACKLOG");
    });
  });

  it("shows Closing… while the request is pending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    useBoardStore.setState({
      cycleModal: { kind: "seal", cycleId: "cyc-111" },
    });
    wrapQC(<SealCycleModal cycle={CYCLE_ACTIVE} cycles={[]} tasks={TASKS} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Close cycle" }),
    );

    expect(
      await screen.findByRole("button", { name: "Closing…" }),
    ).toBeDisabled();
  });

  it("sends PATCH { state:'CLOSED', carry_to:'C-02' } when next-PLANNED selected", async () => {
    const stub = makePatchStub({ ...CYCLE_ACTIVE, state: "CLOSED" });
    vi.stubGlobal("fetch", stub);
    useBoardStore.setState({
      cycleModal: { kind: "seal", cycleId: "cyc-111" },
    });
    wrapQC(
      <SealCycleModal
        cycle={CYCLE_ACTIVE}
        cycles={[CYCLE_PLANNED]}
        tasks={TASKS}
      />,
    );

    // Select the PLANNED cycle carry option
    await userEvent.click(
      screen.getByTestId(`seal-cycle-carry-${CYCLE_PLANNED.code}`),
    );
    await userEvent.click(screen.getByTestId("seal-cycle-commit"));

    await waitFor(() => {
      const patchCalls = stub.mock.calls.filter(
        ([, opts]) => (opts as RequestInit)?.method === "PATCH",
      );
      const body = JSON.parse(
        (patchCalls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body.state).toBe("CLOSED");
      expect(body.carry_to).toBe("C-02");
    });
  });

  it("sends PATCH { state:'CLOSED' } WITHOUT carry_to when LEAVE selected", async () => {
    const stub = makePatchStub({ ...CYCLE_ACTIVE, state: "CLOSED" });
    vi.stubGlobal("fetch", stub);
    useBoardStore.setState({
      cycleModal: { kind: "seal", cycleId: "cyc-111" },
    });
    wrapQC(<SealCycleModal cycle={CYCLE_ACTIVE} cycles={[]} tasks={TASKS} />);

    // Select LEAVE IN CYCLE
    await userEvent.click(screen.getByTestId("seal-cycle-carry-LEAVE"));
    await userEvent.click(screen.getByTestId("seal-cycle-commit"));

    await waitFor(() => {
      const patchCalls = stub.mock.calls.filter(
        ([, opts]) => (opts as RequestInit)?.method === "PATCH",
      );
      const body = JSON.parse(
        (patchCalls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(body.state).toBe("CLOSED");
      expect("carry_to" in body).toBe(false);
    });
  });

  it("on success: closes modal", async () => {
    const stub = makePatchStub({ ...CYCLE_ACTIVE, state: "CLOSED" });
    vi.stubGlobal("fetch", stub);
    useBoardStore.setState({
      cycleModal: { kind: "seal", cycleId: "cyc-111" },
    });
    wrapQC(<SealCycleModal cycle={CYCLE_ACTIVE} cycles={[]} tasks={TASKS} />);

    await userEvent.click(screen.getByTestId("seal-cycle-commit"));

    await waitFor(() => {
      expect(useBoardStore.getState().cycleModal).toBeNull();
    });
  });
});

describe("SealCycleModal — close behaviour", () => {
  it("ESC closes without PATCH", async () => {
    const stub = makePatchStub();
    vi.stubGlobal("fetch", stub);
    useBoardStore.setState({
      cycleModal: { kind: "seal", cycleId: "cyc-111" },
    });
    wrapQC(<SealCycleModal cycle={CYCLE_ACTIVE} cycles={[]} tasks={[]} />);

    await userEvent.keyboard("{Escape}");

    expect(useBoardStore.getState().cycleModal).toBeNull();
    const patchCalls = stub.mock.calls.filter(
      ([, opts]) => (opts as RequestInit)?.method === "PATCH",
    );
    expect(patchCalls).toHaveLength(0);
  });

  it("CANCEL button closes without PATCH", async () => {
    const stub = makePatchStub();
    vi.stubGlobal("fetch", stub);
    useBoardStore.setState({
      cycleModal: { kind: "seal", cycleId: "cyc-111" },
    });
    wrapQC(<SealCycleModal cycle={CYCLE_ACTIVE} cycles={[]} tasks={[]} />);

    await userEvent.click(screen.getByTestId("seal-cycle-cancel"));

    expect(useBoardStore.getState().cycleModal).toBeNull();
    const patchCalls = stub.mock.calls.filter(
      ([, opts]) => (opts as RequestInit)?.method === "PATCH",
    );
    expect(patchCalls).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TaskingScreen integration
// ══════════════════════════════════════════════════════════════════════════════

describe("TaskingScreen — cycle modal integration", () => {
  function renderScreen() {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={qc}>
        <TaskingScreen />
      </QueryClientProvider>,
    );
  }

  it("mounts NewCycleModal when cycleModal.kind === 'new'", async () => {
    stubBoardFetch();
    renderScreen();
    await screen.findByText("Task Board");

    useBoardStore.setState({ cycleModal: { kind: "new" } });

    expect(await screen.findByTestId("new-cycle-modal")).toBeInTheDocument();
  });

  it("does NOT mount NewCycleModal when cycleModal is null", async () => {
    stubBoardFetch();
    renderScreen();
    await screen.findByText("Task Board");

    expect(screen.queryByTestId("new-cycle-modal")).not.toBeInTheDocument();
  });

  it("mounts OpenCycleModal when cycleModal.kind === 'open' and cycleId resolves", async () => {
    stubBoardFetch();
    renderScreen();
    await screen.findByText("Task Board");

    // BOARD_FIXTURE has cyc-111 = ACTIVE (C-01) and cyc-222 = PLANNED (C-02)
    useBoardStore.setState({
      cycleModal: { kind: "open", cycleId: "cyc-222" },
    });

    expect(await screen.findByTestId("open-cycle-modal")).toBeInTheDocument();
  });

  it("does NOT mount OpenCycleModal when cycleId does not match any cycle", async () => {
    stubBoardFetch();
    renderScreen();
    await screen.findByText("Task Board");

    useBoardStore.setState({
      cycleModal: { kind: "open", cycleId: "ghost-id" },
    });

    expect(screen.queryByTestId("open-cycle-modal")).not.toBeInTheDocument();
  });

  it("mounts SealCycleModal when cycleModal.kind === 'seal' and cycleId resolves", async () => {
    stubBoardFetch();
    renderScreen();
    await screen.findByText("Task Board");

    useBoardStore.setState({
      cycleModal: { kind: "seal", cycleId: "cyc-111" },
    });

    expect(await screen.findByTestId("seal-cycle-modal")).toBeInTheDocument();
  });

  it("does NOT mount SealCycleModal when cycleId does not match any cycle", async () => {
    stubBoardFetch();
    renderScreen();
    await screen.findByText("Task Board");

    useBoardStore.setState({
      cycleModal: { kind: "seal", cycleId: "ghost-id" },
    });

    expect(screen.queryByTestId("seal-cycle-modal")).not.toBeInTheDocument();
  });
});
