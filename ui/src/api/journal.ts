import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const API_BASE = "/api/vault/journal";

/** Shape returned by journal detail endpoints (same as PageDetail). */
export interface JournalDetail {
  path: string;
  canonical_name: string;
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
  return useQuery<JournalDetail>({
    queryKey: ["journal", "today"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/today`);
      if (!res.ok) throw new Error("Failed to fetch journal");
      return res.json();
    },
  });
}

export function useJournalByDate(date: string) {
  return useQuery<JournalDetail>({
    queryKey: ["journal", date],
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
    queryKey: ["journal", "recent", days],
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journal"] });
    },
  });
}
