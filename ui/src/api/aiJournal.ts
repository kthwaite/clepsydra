import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "#/api/schema";
import { fetchClient } from "./client";
import { invalidatePageContent, queryKeys } from "./keys";

/** Shape returned by AI journal detail endpoints (same as PageDetail). */
export type AiJournalDetail = components["schemas"]["PageDetailResponse"];
export type AiJournalSummary = components["schemas"]["JournalSummary"];

function apiError(error: components["schemas"]["ApiError"], fallback: string) {
  return new Error(error.error || fallback);
}

export function useAiJournalToday(enabled = true) {
  return useQuery<AiJournalDetail | null>({
    queryKey: queryKeys.aiJournal.today,
    enabled,
    // Opt out of the global throwOnError: a transient failure must surface as
    // error state rather than throw into FolioBoundary.
    throwOnError: false,
    queryFn: async () => {
      const { data, error, response } = await fetchClient.GET(
        "/api/vault/ai-journal/today",
      );
      if (response.status === 404) return null;
      if (error) throw apiError(error, "Failed to fetch AI journal");
      if (!data) throw new Error("AI journal response was empty");
      return data;
    },
  });
}

export interface EnsureAiJournalResult {
  page: AiJournalDetail;
  created: boolean;
}

/**
 * POST /ai-journal/today — create today's AI journal if missing (get-or-create).
 * The journal template lives server-side; `created` distinguishes 201 from
 * 200 so the editor can detect a concurrently-written page.
 */
export function useEnsureAiJournalToday() {
  const qc = useQueryClient();
  return useMutation<EnsureAiJournalResult, Error, void>({
    mutationFn: async () => {
      const { data, error, response } = await fetchClient.POST(
        "/api/vault/ai-journal/today",
        {},
      );
      if (error) throw apiError(error, "Failed to create today's AI journal");
      if (!data) throw new Error("AI journal creation response was empty");
      return { page: data, created: response.status === 201 };
    },
    onSuccess: ({ page }) => invalidatePageContent(qc, page.path),
  });
}

export function useAiJournalRecent(days = 7) {
  return useQuery<AiJournalSummary[]>({
    queryKey: queryKeys.aiJournal.recent(days),
    queryFn: async () => {
      const { data, error } = await fetchClient.GET(
        "/api/vault/ai-journal/recent",
        { params: { query: { days } } },
      );
      if (error) throw apiError(error, "Failed to fetch recent AI journals");
      return data ?? [];
    },
  });
}
