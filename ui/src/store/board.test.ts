import { beforeEach, describe, expect, it } from "vitest";
import { useBoardStore } from "./board";

// Reset store state before each test
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

describe("useBoardStore defaults", () => {
  it("has correct default persisted values", () => {
    const s = useBoardStore.getState();
    expect(s.mode).toBe("card");
    expect(s.opFilter).toBe("ALL");
    expect(s.cycleSel).toBe("");
    expect(s.railOpen).toBe(true);
  });

  it("has correct default ephemeral values", () => {
    const s = useBoardStore.getState();
    expect(s.editTaskId).toBeNull();
    expect(s.taskModal).toBeNull();
    expect(s.cycleModal).toBeNull();
  });
});

describe("useBoardStore setters", () => {
  it("setMode updates mode", () => {
    useBoardStore.getState().setMode("backlog");
    expect(useBoardStore.getState().mode).toBe("backlog");
  });

  it("setOpFilter updates opFilter", () => {
    useBoardStore.getState().setOpFilter("UNFILED");
    expect(useBoardStore.getState().opFilter).toBe("UNFILED");
  });

  it("setCycleSel updates cycleSel", () => {
    useBoardStore.getState().setCycleSel("2026-Q2");
    expect(useBoardStore.getState().cycleSel).toBe("2026-Q2");
  });

  it("setRailOpen updates railOpen", () => {
    useBoardStore.getState().setRailOpen(false);
    expect(useBoardStore.getState().railOpen).toBe(false);
  });

  it("setEditTaskId updates editTaskId", () => {
    useBoardStore.getState().setEditTaskId("task-abc");
    expect(useBoardStore.getState().editTaskId).toBe("task-abc");
    useBoardStore.getState().setEditTaskId(null);
    expect(useBoardStore.getState().editTaskId).toBeNull();
  });
});

describe("useBoardStore task modal", () => {
  it("openTaskModal sets taskModal with opts", () => {
    useBoardStore
      .getState()
      .openTaskModal({ project: "proj-1", status: "todo" });
    expect(useBoardStore.getState().taskModal).toEqual({
      project: "proj-1",
      status: "todo",
    });
  });

  it("openTaskModal with no args sets empty object", () => {
    useBoardStore.getState().openTaskModal();
    expect(useBoardStore.getState().taskModal).toEqual({});
  });

  it("closeTaskModal clears taskModal", () => {
    useBoardStore.getState().openTaskModal({ cycle: "c1" });
    useBoardStore.getState().closeTaskModal();
    expect(useBoardStore.getState().taskModal).toBeNull();
  });
});

describe("useBoardStore cycle modal", () => {
  it("openCycleModal sets new cycle modal", () => {
    useBoardStore.getState().openCycleModal({ kind: "new" });
    expect(useBoardStore.getState().cycleModal).toEqual({ kind: "new" });
  });

  it("openCycleModal sets open/seal cycle modal with cycleId", () => {
    useBoardStore
      .getState()
      .openCycleModal({ kind: "seal", cycleId: "cycle-xyz" });
    expect(useBoardStore.getState().cycleModal).toEqual({
      kind: "seal",
      cycleId: "cycle-xyz",
    });
  });

  it("closeCycleModal clears cycleModal", () => {
    useBoardStore.getState().openCycleModal({ kind: "new" });
    useBoardStore.getState().closeCycleModal();
    expect(useBoardStore.getState().cycleModal).toBeNull();
  });
});

describe("useBoardStore persist partialize", () => {
  it("partialize includes only persisted fields", () => {
    // Access the persist options via the store's internal config
    const options = (
      useBoardStore as unknown as {
        persist: { getOptions: () => { partialize?: (s: unknown) => unknown };
      };
    }).persist.getOptions();

    const fullState = {
      mode: "timeline" as const,
      opFilter: "OPS-1",
      cycleSel: "2026-Q2",
      railOpen: false,
      editTaskId: "task-123",
      taskModal: { project: "p" },
      cycleModal: { kind: "new" as const },
    };

    const partial = options.partialize?.(fullState) as Record<string, unknown>;

    expect(partial).toEqual({
      mode: "timeline",
      opFilter: "OPS-1",
      cycleSel: "2026-Q2",
      railOpen: false,
    });
    expect("editTaskId" in partial).toBe(false);
    expect("taskModal" in partial).toBe(false);
    expect("cycleModal" in partial).toBe(false);
  });
});
