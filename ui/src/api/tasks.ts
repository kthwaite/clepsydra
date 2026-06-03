import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invalidatePageContent, queryKeys } from "./keys";

const API_BASE = "/api/vault";

export interface TaskItem {
  block_id: string | null;
  content: string;
  status: string;
  properties: Record<string, string>;
  page_path: string;
  page_title: string | null;
  span_start: number;
  span_end: number;
}

export interface AgendaTodayResponse {
  tasks: TaskItem[];
}

export interface AgendaWeekResponse {
  days: Array<{ date: string; tasks: TaskItem[] }>;
}

export interface AgendaOverdueResponse {
  tasks: TaskItem[];
}

export interface TaskListResponse {
  tasks: TaskItem[];
  total: number;
}

export function useAgendaToday() {
  return useQuery<AgendaTodayResponse>({
    queryKey: queryKeys.agenda.today,
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/agenda/today`);
      if (!res.ok) throw new Error("Failed to fetch agenda");
      return res.json();
    },
  });
}

export function useAgendaWeek() {
  return useQuery<AgendaWeekResponse>({
    queryKey: queryKeys.agenda.week,
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/agenda/week`);
      if (!res.ok) throw new Error("Failed to fetch weekly agenda");
      return res.json();
    },
  });
}

export function useAgendaOverdue() {
  return useQuery<AgendaOverdueResponse>({
    queryKey: queryKeys.agenda.overdue,
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/agenda/overdue`);
      if (!res.ok) throw new Error("Failed to fetch overdue tasks");
      return res.json();
    },
  });
}

export function useTasks(params: Record<string, string>) {
  const search = new URLSearchParams(params).toString();
  return useQuery<TaskListResponse>({
    queryKey: queryKeys.tasks.list(params),
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/tasks?${search}`);
      if (!res.ok) throw new Error("Failed to fetch tasks");
      return res.json();
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
      const res = await fetch(`${API_BASE}/tasks/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          page_path: pagePath,
          span_start: spanStart,
          status,
        }),
      });
      if (!res.ok) throw new Error("Failed to update task");
      return res.json();
    },
    onSuccess: (_data, variables) =>
      invalidatePageContent(qc, variables.pagePath),
  });
}
