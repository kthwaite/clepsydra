import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { components, operations } from "#/api/schema";
import { fetchClient } from "./client";
import { invalidatePageContent, queryKeys } from "./keys";

export type TaskItem = components["schemas"]["TaskItem"];
export type AgendaResponse = components["schemas"]["AgendaResponse"];
export type AgendaItem = components["schemas"]["AgendaItem"];
export type AgendaTodo = Extract<AgendaItem, { kind: "todo" }>;
export type AgendaTask = Extract<AgendaItem, { kind: "task" }>;
export type TaskListResponse = components["schemas"]["TaskListResponse"];
type TaskCompletionHistoryResponse =
  components["schemas"]["TaskCompletionHistoryResponse"];
type CycleBurndownResponse = components["schemas"]["CycleBurndownResponse"];
export type TaskFilters = NonNullable<
  operations["list_tasks"]["parameters"]["query"]
>;

function apiError(error: components["schemas"]["ApiError"], fallback: string) {
  return new Error(error.error || fallback);
}

export function useAgenda(today: string) {
  return useQuery<AgendaResponse>({
    queryKey: queryKeys.agenda.byDate(today),
    queryFn: async () => {
      const { data, error } = await fetchClient.GET("/api/vault/agenda", {
        params: { query: { today } },
      });
      if (error) throw apiError(error, "Failed to fetch Agenda");
      if (!data) throw new Error("Agenda response was empty");
      return data;
    },
  });
}

export function useTasks(params: TaskFilters) {
  return useQuery<TaskListResponse>({
    queryKey: queryKeys.tasks.list(params),
    queryFn: async () => {
      const { data, error } = await fetchClient.GET("/api/vault/tasks", {
        params: { query: params },
      });
      if (error) throw apiError(error, "Failed to fetch tasks");
      if (!data) throw new Error("Task list response was empty");
      return data;
    },
  });
}

export function useTaskCompletionHistory(
  project?: string,
  unfiled = false,
  enabled = true,
) {
  return useQuery<TaskCompletionHistoryResponse>({
    queryKey: queryKeys.tasks.history(project, unfiled),
    enabled,
    throwOnError: false,
    queryFn: async () => {
      const { data, error } = await fetchClient.GET(
        "/api/vault/tasks/history",
        {
          params: {
            query: { days: 14, project, unfiled: unfiled || undefined },
          },
        },
      );
      if (error) throw apiError(error, "Failed to fetch task history");
      if (!data) throw new Error("Task history response was empty");
      return data;
    },
  });
}

export function useCycleBurndown(
  cycle: string | null,
  project?: string,
  unfiled = false,
  enabled = true,
) {
  return useQuery<CycleBurndownResponse>({
    queryKey: queryKeys.agenda.cycleBurndown(cycle, project, unfiled),
    enabled: enabled && cycle !== null,
    throwOnError: false,
    queryFn: async () => {
      if (cycle === null) throw new Error("Cycle is required");
      const { data, error } = await fetchClient.GET(
        "/api/vault/agenda/cycle-burndown",
        {
          params: {
            query: { cycle, project, unfiled: unfiled || undefined },
          },
        },
      );
      if (error) throw apiError(error, "Failed to fetch cycle burndown");
      if (!data) throw new Error("Cycle burndown response was empty");
      return data;
    },
  });
}

export function useToggleTaskStatus() {
  const qc = useQueryClient();
  return useMutation<
    TaskItem,
    Error,
    { pagePath: string; spanStart: number; status: string }
  >({
    mutationFn: async ({ pagePath, spanStart, status }) => {
      const { data, error } = await fetchClient.PUT("/api/vault/tasks/status", {
        body: {
          page_path: pagePath,
          span_start: spanStart,
          status,
        },
      });
      if (error) throw apiError(error, "Failed to update task");
      if (!data) throw new Error("Task update response was empty");
      return data;
    },
    onSuccess: (_data, variables) =>
      invalidatePageContent(qc, variables.pagePath),
  });
}
