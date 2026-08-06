import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invalidatePageContent, queryKeys } from "./keys";

const API_BASE = "/api/vault/journal";

/** Shape returned by journal detail endpoints (same as PageDetail). */
export interface JournalDetail {
  path: string;
  canonical_name: string;
  revision: string;
  meta: {
    id: string;
    title?: string | null;
    tags?: string[] | null;
    aliases?: string[] | null;
    created_at?: string | null;
    updated_at?: string | null;
  };
  body: string;
}

export interface JournalSummary {
  id: string;
  path: string;
  title: string | null;
  journal_date: string;
}

export function useJournalToday() {
  return useQuery<JournalDetail | null>({
    queryKey: queryKeys.journal.today,
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/today`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to fetch journal");
      return res.json();
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
      const res = await fetch(`${API_BASE}/today`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to create today's journal");
      const page = (await res.json()) as JournalDetail;
      return { page, created: res.status === 201 };
    },
    onSuccess: ({ page }) => invalidatePageContent(qc, page.path),
  });
}

export function useJournalByDate(date: string) {
  return useQuery<JournalDetail>({
    queryKey: queryKeys.journal.byDate(date),
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/${date}`);
      if (!res.ok) throw new Error("Failed to fetch journal");
      return res.json();
    },
    enabled: !!date,
  });
}

export function useJournalRecent(days = 7) {
  return useQuery<JournalSummary[]>({
    queryKey: queryKeys.journal.recent(days),
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/recent?days=${days}`);
      if (!res.ok) throw new Error("Failed to fetch recent journals");
      return res.json();
    },
  });
}

export function useQuickCapture() {
  const qc = useQueryClient();
  return useMutation<JournalDetail, Error, string>({
    mutationFn: async (content: string) => {
      const res = await fetch(`${API_BASE}/today/capture`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error("Capture failed");
      return res.json();
    },
    // The capture response carries the journal page's own vault path, so we can
    // scope the body invalidation to it (journal.all below covers the digests).
    onSuccess: (data) => invalidatePageContent(qc, data.path),
  });
}
