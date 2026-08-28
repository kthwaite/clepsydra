import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardResponse, BoardTask } from "#/api/board";
import {
  applyTaskPatch,
  useArchiveTask,
  useCreateCycle,
  useCreateTask,
  usePatchCycle,
  usePatchTask,
} from "#/api/board";
import { queryKeys } from "#/api/keys";

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

function freshQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function makeTask(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id: "task-1",
    code: "T-1",
    title: "Test task",
    body_excerpt: null,
    status: "BACKLOG",
    priority: "MEDIUM",
    path: "tasks/T-1.md",
    tags: [],
    checks: [],
    updated_at: "2026-06-11T00:00:00Z",
    cycle: null,
    assignee: null,
    estimate: null,
    due: null,
    hold: null,
    link: null,
    project: null,
    start: null,
    ...overrides,
  };
}

function makeBoard(tasks: BoardTask[]): BoardResponse {
  return {
    columns: [],
    cycles: [],
    operations: [],
    tasks,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyTaskPatch", () => {
  it("moves status when status is provided", () => {
    const board = makeBoard([makeTask({ status: "BACKLOG" })]);
    const result = applyTaskPatch(board, "task-1", { status: "DOING" });
    expect(result.tasks[0].status).toBe("DOING");
  });

  it("leaves status unchanged when status is absent from patch", () => {
    const board = makeBoard([makeTask({ status: "BACKLOG" })]);
    const result = applyTaskPatch(board, "task-1", { priority: "HIGH" });
    expect(result.tasks[0].status).toBe("BACKLOG");
  });

  it("clears hold to null when hold is explicitly null", () => {
    const board = makeBoard([makeTask({ hold: "blocked by design" })]);
    const result = applyTaskPatch(board, "task-1", { hold: null });
    expect(result.tasks[0].hold).toBeNull();
  });

  it("leaves cycle unchanged when cycle is absent from patch", () => {
    const board = makeBoard([makeTask({ cycle: "S-10" })]);
    const result = applyTaskPatch(board, "task-1", { status: "DOING" });
    expect(result.tasks[0].cycle).toBe("S-10");
  });

  it("sets cycle when cycle is a string value", () => {
    const board = makeBoard([makeTask({ cycle: null })]);
    const result = applyTaskPatch(board, "task-1", { cycle: "S-12" });
    expect(result.tasks[0].cycle).toBe("S-12");
  });

  it("clears cycle when cycle is null", () => {
    const board = makeBoard([makeTask({ cycle: "S-10" })]);
    const result = applyTaskPatch(board, "task-1", { cycle: null });
    expect(result.tasks[0].cycle).toBeNull();
  });

  it("leaves start unchanged when start is absent from patch", () => {
    const board = makeBoard([makeTask({ start: "2026-08-01" })]);
    const result = applyTaskPatch(board, "task-1", { status: "DOING" });
    expect(result.tasks[0].start).toBe("2026-08-01");
  });

  it("sets start when start is a string value", () => {
    const board = makeBoard([makeTask({ start: null })]);
    const result = applyTaskPatch(board, "task-1", { start: "2026-08-02" });
    expect(result.tasks[0].start).toBe("2026-08-02");
  });

  it("clears start when start is null", () => {
    const board = makeBoard([makeTask({ start: "2026-08-01" })]);
    const result = applyTaskPatch(board, "task-1", { start: null });
    expect(result.tasks[0].start).toBeNull();
  });

  it("replaces tags when tags array is provided", () => {
    const board = makeBoard([makeTask({ tags: ["feat", "urgent"] })]);
    const result = applyTaskPatch(board, "task-1", { tags: ["chore"] });
    expect(result.tasks[0].tags).toEqual(["chore"]);
  });

  it("leaves tags unchanged when tags is absent from patch", () => {
    const board = makeBoard([makeTask({ tags: ["feat"] })]);
    const result = applyTaskPatch(board, "task-1", { status: "DONE" });
    expect(result.tasks[0].tags).toEqual(["feat"]);
  });

  it("clears project when project is the empty-string wire sentinel", () => {
    const board = makeBoard([makeTask({ project: "op-a" })]);
    const result = applyTaskPatch(board, "task-1", { project: "" });
    expect(result.tasks[0].project).toBeNull();
  });

  it("leaves project unchanged when project is null (backend no-op)", () => {
    const board = makeBoard([makeTask({ project: "op-a" })]);
    const result = applyTaskPatch(board, "task-1", { project: null });
    expect(result.tasks[0].project).toBe("op-a");
  });

  it("sets project when project is a non-empty string", () => {
    const board = makeBoard([makeTask({ project: "op-a" })]);
    const result = applyTaskPatch(board, "task-1", { project: "op-b" });
    expect(result.tasks[0].project).toBe("op-b");
  });

  it("returns board unchanged when id is not found", () => {
    const board = makeBoard([makeTask()]);
    const result = applyTaskPatch(board, "no-such-id", { status: "DONE" });
    expect(result).toBe(board); // same reference
  });

  it("does not mutate the original board", () => {
    const task = makeTask({ status: "BACKLOG" });
    const board = makeBoard([task]);
    applyTaskPatch(board, "task-1", { status: "DOING" });
    expect(board.tasks[0].status).toBe("BACKLOG");
    expect(task.status).toBe("BACKLOG");
  });

  it("leaves other tasks untouched when one task is patched", () => {
    const t1 = makeTask({ id: "task-1", status: "BACKLOG" });
    const t2 = makeTask({ id: "task-2", status: "DOING" });
    const board = makeBoard([t1, t2]);
    const result = applyTaskPatch(board, "task-1", { status: "DONE" });
    expect(result.tasks[0].status).toBe("DONE");
    expect(result.tasks[1].status).toBe("DOING");
    expect(result.tasks[1]).toBe(t2); // same reference for untouched task
  });
});

// ---------------------------------------------------------------------------
// Mutation Error Toast Tests
// ---------------------------------------------------------------------------

describe("Board mutations", () => {
  it("toasts when a patch fails and rolls back", async () => {
    const queryClient = freshQueryClient();
    const board: BoardResponse = {
      columns: [],
      cycles: [],
      operations: [],
      tasks: [makeTask({ id: "task-1", status: "BACKLOG" })],
    };
    queryClient.setQueryData(queryKeys.board.all, board);

    vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("Network error"));

    const { result } = renderHook(() => usePatchTask(), {
      wrapper: wrapper(queryClient),
    });

    try {
      await result.current.mutateAsync({
        id: "task-1",
        patch: { status: "DOING" },
      });
    } catch {
      // Expected error
    }

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("TASK EDIT FAILED — REVERTED");
    });

    // Verify rollback occurred: data should be back to original
    const cachedBoard = queryClient.getQueryData<BoardResponse>(
      queryKeys.board.all,
    );
    expect(cachedBoard?.tasks[0].status).toBe("BACKLOG");
  });

  it("invalidates every Agenda query after a successful task patch", async () => {
    const queryClient = freshQueryClient();
    queryClient.setQueryData(queryKeys.board.all, makeBoard([makeTask()]));
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(makeTask({ status: "DOING" })), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { result } = renderHook(() => usePatchTask(), {
      wrapper: wrapper(queryClient),
    });

    await result.current.mutateAsync({
      id: "task-1",
      patch: { status: "DOING" },
    });

    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.agenda.all,
      });
    });
  });

  it("toasts when create task fails", async () => {
    const queryClient = freshQueryClient();
    queryClient.setQueryData(queryKeys.board.all, {
      columns: [],
      cycles: [],
      operations: [],
      tasks: [],
    });

    vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("Network error"));

    const { result } = renderHook(() => useCreateTask(), {
      wrapper: wrapper(queryClient),
    });

    try {
      await result.current.mutateAsync({
        title: "New task",
      });
    } catch {
      // Expected error
    }

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Couldn’t create task");
    });
  });

  it("accepts the typed archive summary and invalidates board, page, and Rubbish caches", async () => {
    const queryClient = freshQueryClient();
    const pageListKey = ["get", "/api/vault/pages"] as const;
    const archived = {
      archive_url: null,
      deleted_at: "2026-08-14T10:00:00Z",
      item_id: "rubbish-1",
      kind: "TASK",
      original_path: "tasks/T-1.md",
      page_id: "task-1",
      title: "Test task",
    };
    queryClient.setQueryData(queryKeys.board.all, makeBoard([makeTask()]));
    queryClient.setQueryData(pageListKey, []);
    queryClient.setQueryData(queryKeys.rubbish.all, { items: [] });
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(archived), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { result } = renderHook(() => useArchiveTask(), {
      wrapper: wrapper(queryClient),
    });

    const response = await result.current.mutateAsync({
      path: "tasks/T-1.md",
    });

    expect(response).toEqual(archived);
    const request = fetchSpy.mock.calls[0][0];
    const url =
      typeof request === "string"
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url;
    expect(new URL(url, "http://localhost").search).toBe("");
    expect(queryClient.getQueryState(queryKeys.board.all)?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(pageListKey)?.isInvalidated).toBe(true);
    expect(
      queryClient.getQueryState(queryKeys.rubbish.all)?.isInvalidated,
    ).toBe(true);
  });

  it("toasts when archiving a task fails", async () => {
    const queryClient = freshQueryClient();
    queryClient.setQueryData(queryKeys.board.all, makeBoard([makeTask()]));

    vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("Network error"));

    const { result } = renderHook(() => useArchiveTask(), {
      wrapper: wrapper(queryClient),
    });

    await expect(
      result.current.mutateAsync({
        path: "tasks/T-1.md",
      }),
    ).rejects.toThrow("Network error");

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Couldn’t archive task");
    });
  });

  it("toasts when create cycle fails", async () => {
    const queryClient = freshQueryClient();
    queryClient.setQueryData(queryKeys.board.all, {
      columns: [],
      cycles: [],
      operations: [],
      tasks: [],
    });

    vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("Network error"));

    const { result } = renderHook(() => useCreateCycle(), {
      wrapper: wrapper(queryClient),
    });

    try {
      await result.current.mutateAsync({
        label: "New cycle",
        start: "2026-08-11",
        end: "2026-08-25",
      });
    } catch {
      // Expected error
    }

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("CYCLE CREATION FAILED");
    });
  });

  it("toasts when patch cycle fails", async () => {
    const queryClient = freshQueryClient();
    queryClient.setQueryData(queryKeys.board.all, {
      columns: [],
      cycles: [],
      operations: [],
      tasks: [],
    });

    vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("Network error"));

    const { result } = renderHook(() => usePatchCycle(), {
      wrapper: wrapper(queryClient),
    });

    try {
      await result.current.mutateAsync({
        id: "cycle-1",
        patch: { state: "ACTIVE" },
      });
    } catch {
      // Expected error
    }

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("CYCLE UPDATE FAILED");
    });
  });
});
