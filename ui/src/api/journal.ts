import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { components } from "#/api/schema";
import type { PageEditorOptions } from "#/editor/usePageEditor";
import { todayJournalPath } from "#/lib/journal";
import { fetchClient } from "./client";
import { invalidatePageContent, queryKeys } from "./keys";

/** Shape returned by journal detail endpoints (same as PageDetail). */
export type JournalDetail = components["schemas"]["PageDetailResponse"];
export type JournalSummary = components["schemas"]["JournalSummary"];
export type JournalTodayResponse =
  components["schemas"]["JournalTodayResponse"];

function apiError(error: components["schemas"]["ApiError"], fallback: string) {
  return new Error(error.error || fallback);
}

export function useJournalToday(enabled = true) {
  return useQuery<JournalTodayResponse | null>({
    queryKey: queryKeys.journal.today,
    enabled,
    queryFn: async () => {
      const { data, error, response } = await fetchClient.GET(
        "/api/vault/journal/today",
      );
      if (response.status === 404) return null;
      if (error) throw apiError(error, "Failed to fetch journal");
      if (!data) throw new Error("Journal response was empty");
      return data;
    },
  });
}

export interface EnsureJournalResult {
  page: JournalDetail;
  created: boolean;
}

/**
 * POST /journal/today — create today's journal if missing (get-or-create).
 * The journal template lives server-side; `created` distinguishes 201 from
 * 200 so the editor can detect a concurrently-written page.
 */
export function useEnsureJournalToday() {
  const qc = useQueryClient();
  return useMutation<EnsureJournalResult, Error, void>({
    mutationFn: async () => {
      const { data, error, response } = await fetchClient.POST(
        "/api/vault/journal/today",
        {},
      );
      if (error) throw apiError(error, "Failed to create today's journal");
      if (!data) throw new Error("Journal creation response was empty");
      return { page: data, created: response.status === 201 };
    },
    onSuccess: ({ page }) => invalidatePageContent(qc, page.path),
  });
}

/** FOLIO's journal wiring: today's journal binds before the file exists and
 *  is created on first write; every other path edits normally. */
export function useJournalEditorOptions(
  path: string,
): PageEditorOptions | undefined {
  const ensureToday = useEnsureJournalToday();
  const mutateAsync = ensureToday.mutateAsync;
  const isToday = path === todayJournalPath();
  return useMemo(
    () => (isToday ? { ensure: () => mutateAsync() } : undefined),
    [isToday, mutateAsync],
  );
}

export function useJournalRecent(days = 7) {
  return useQuery<JournalSummary[]>({
    queryKey: queryKeys.journal.recent(days),
    queryFn: async () => {
      const { data, error } = await fetchClient.GET(
        "/api/vault/journal/recent",
        { params: { query: { days } } },
      );
      if (error) throw apiError(error, "Failed to fetch recent journals");
      return data ?? [];
    },
  });
}

export function useQuickCapture() {
  const qc = useQueryClient();
  return useMutation<JournalDetail, Error, string>({
    mutationFn: async (content: string) => {
      const { data, error } = await fetchClient.POST(
        "/api/vault/journal/today/capture",
        { body: { content } },
      );
      if (error) throw apiError(error, "Capture failed");
      if (!data) throw new Error("Capture response was empty");
      return data;
    },
    // The capture response carries the journal page's own vault path, so we can
    // scope the body invalidation to it (journal.all below covers the digests).
    onSuccess: (data) => invalidatePageContent(qc, data.path),
  });
}
