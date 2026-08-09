import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { components, operations } from "#/api/schema";
import { fetchClient } from "./client";
import { invalidatePageContent, queryKeys } from "./keys";

export type TaskItem = components["schemas"]["TaskItem"];
export type AgendaTodayResponse = components["schemas"]["AgendaTodayResponse"];
export type AgendaWeekResponse = components["schemas"]["AgendaWeekResponse"];
export type AgendaOverdueResponse =
  components["schemas"]["AgendaOverdueResponse"];
export type TaskListResponse = components["schemas"]["TaskListResponse"];
export type TaskFilters = NonNullable<
  operations["list_tasks"]["parameters"]["query"]
>;

function apiError(error: components["schemas"]["ApiError"], fallback: string) {
  return new Error(error.error || fallback);
}

export function useAgendaToday() {
  return useQuery<AgendaTodayResponse>({
    queryKey: queryKeys.agenda.today,
    queryFn: async () => {
      const { data, error } = await fetchClient.GET("/api/vault/agenda/today");
      if (error) throw apiError(error, "Failed to fetch agenda");
      if (!data) throw new Error("Agenda response was empty");
      return data;
    },
  });
}

export function useAgendaWeek() {
  return useQuery<AgendaWeekResponse>({
    queryKey: queryKeys.agenda.week,
    queryFn: async () => {
      const { data, error } = await fetchClient.GET("/api/vault/agenda/week");
      if (error) throw apiError(error, "Failed to fetch weekly agenda");
      if (!data) throw new Error("Weekly agenda response was empty");
      return data;
    },
  });
}

export function useAgendaOverdue() {
  return useQuery<AgendaOverdueResponse>({
    queryKey: queryKeys.agenda.overdue,
    queryFn: async () => {
      const { data, error } = await fetchClient.GET(
        "/api/vault/agenda/overdue",
      );
      if (error) throw apiError(error, "Failed to fetch overdue tasks");
      if (!data) throw new Error("Overdue agenda response was empty");
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
