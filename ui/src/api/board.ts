import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "#/api/schema";
import { queryKeys } from "./keys";

export type BoardTask = components["schemas"]["BoardTask"];
export type BoardCycle = components["schemas"]["BoardCycle"];
export type BoardOperation = components["schemas"]["BoardOperation"];
export type BoardColumn = components["schemas"]["BoardColumn"];
export type BoardResponse = components["schemas"]["BoardResponse"];
export type CreateTaskRequest = components["schemas"]["CreateTaskRequest"];
export type PatchTaskRequest = components["schemas"]["PatchTaskRequest"];
export type CreateCycleRequest = components["schemas"]["CreateCycleRequest"];
export type PatchCycleRequest = components["schemas"]["PatchCycleRequest"];

const API_BASE = "/api/vault/board";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Apply a PatchTaskRequest to a BoardResponse, returning a new BoardResponse.
 * Tri-state semantics for cycle/assignee/estimate/due/hold/link:
 *   - key absent in patch → leave current value unchanged
 *   - key present as null → clear to null
 *   - key present as string → set to that value
 * Plain fields (status/priority/title/project) follow absent-means-keep too.
 * Tags: absent = keep, present (array or null) = replace entirely.
 * Returns the original board unchanged when the task id is not found.
 */
export function applyTaskPatch(
  board: BoardResponse,
  id: string,
  patch: PatchTaskRequest,
): BoardResponse {
  const idx = board.tasks.findIndex((t) => t.id === id);
  if (idx === -1) return board;

  const task = board.tasks[idx];

  // Tri-state helper: apply only when the key is present in the patch object.
  function triState<T extends string | null>(
    current: T | null | undefined,
    key: keyof PatchTaskRequest,
  ): T | null | undefined {
    if (!(key in patch)) return current;
    const v = patch[key];
    // v is string[] | string | null | undefined; we only call this for string fields
    return (v as T | null | undefined) ?? null;
  }

  const updated: BoardTask = {
    ...task,
    // Plain optional fields — absent = keep
    ...("status" in patch && patch.status != null
      ? { status: patch.status }
      : {}),
    ...("priority" in patch && patch.priority != null
      ? { priority: patch.priority }
      : {}),
    ...("title" in patch && patch.title != null ? { title: patch.title } : {}),
    ...("project" in patch ? { project: patch.project ?? null } : {}),
    // Tri-state fields
    cycle: triState(task.cycle, "cycle"),
    assignee: triState(task.assignee, "assignee"),
    estimate: triState(task.estimate, "estimate"),
    due: triState(task.due, "due"),
    hold: triState(task.hold, "hold"),
    link: triState(task.link, "link"),
    // Tags: absent = keep, present = replace
    tags: "tags" in patch && patch.tags != null ? patch.tags : task.tags,
  };

  const tasks = [...board.tasks];
  tasks[idx] = updated;
  return { ...board, tasks };
}

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

export function useBoard() {
  return useQuery<BoardResponse>({
    queryKey: queryKeys.board.all,
    queryFn: async () => {
      const res = await fetch(API_BASE);
      if (!res.ok) throw new Error("Failed to fetch board");
      return res.json() as Promise<BoardResponse>;
    },
  });
}

// ---------------------------------------------------------------------------
// Mutation hooks
// ---------------------------------------------------------------------------

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation<BoardTask, Error, CreateTaskRequest>({
    mutationFn: async (body) => {
      const res = await fetch(`${API_BASE}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to create task");
      return res.json() as Promise<BoardTask>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.board.all }),
  });
}

export function usePatchTask() {
  const qc = useQueryClient();
  return useMutation<
    BoardTask,
    Error,
    { id: string; patch: PatchTaskRequest },
    { previous: BoardResponse | undefined }
  >({
    mutationFn: async ({ id, patch }) => {
      const res = await fetch(`${API_BASE}/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("Failed to patch task");
      return res.json() as Promise<BoardTask>;
    },
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: queryKeys.board.all });
      const previous = qc.getQueryData<BoardResponse>(queryKeys.board.all);
      if (previous) {
        qc.setQueryData<BoardResponse>(
          queryKeys.board.all,
          applyTaskPatch(previous, id, patch),
        );
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous !== undefined) {
        qc.setQueryData(queryKeys.board.all, ctx.previous);
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.board.all }),
  });
}

export function useCreateCycle() {
  const qc = useQueryClient();
  return useMutation<BoardCycle, Error, CreateCycleRequest>({
    mutationFn: async (body) => {
      const res = await fetch(`${API_BASE}/cycles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to create cycle");
      return res.json() as Promise<BoardCycle>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.board.all }),
  });
}

export function usePatchCycle() {
  const qc = useQueryClient();
  return useMutation<
    BoardCycle,
    Error,
    { id: string; patch: PatchCycleRequest }
  >({
    mutationFn: async ({ id, patch }) => {
      const res = await fetch(`${API_BASE}/cycles/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("Failed to patch cycle");
      return res.json() as Promise<BoardCycle>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.board.all }),
  });
}
