import {
  type InfiniteData,
  infiniteQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

export interface Feed {
  id: number;
  url: string;
  site_url: string | null;
  title: string;
  group: string | null;
  tags: string[];
  sort_order: number;
  unread_count: number;
  last_fetch_at: string | null;
  error_count: number;
  last_error: string | null;
}

export interface FeedsResponse {
  feeds: Feed[];
  warnings: string[];
}

export interface Entry {
  id: number;
  feed_id: number;
  feed_title: string;
  group: string | null;
  url: string | null;
  title: string;
  author: string | null;
  content_html: string | null;
  published_at: string | null;
  sort_ts: string;
  read: boolean;
  bookmarked: boolean;
  tags: string[];
}

export interface EntriesResponse {
  entries: Entry[];
  next_cursor: string | null;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      // non-JSON error body; keep the status message
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function useFeeds() {
  return useQuery({
    queryKey: ["feeds"],
    queryFn: () => api<FeedsResponse>("/feeds"),
    refetchInterval: 120_000,
  });
}

export type RiverView = "unread" | "all" | "saved";

export interface EntryFilters {
  view: RiverView;
  group?: string;
  feed?: number;
  tag?: string;
}

export function entriesQuery(f: EntryFilters) {
  return infiniteQueryOptions({
    queryKey: ["entries", f],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams();
      if (f.view === "unread") p.set("unread", "true");
      if (f.view === "saved") p.set("bookmarked", "true");
      if (f.group) p.set("group", f.group);
      if (f.feed) p.set("feed_id", String(f.feed));
      if (f.tag) p.set("tag", f.tag);
      if (pageParam) p.set("cursor", pageParam);
      return api<EntriesResponse>(`/entries?${p}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    refetchInterval: 120_000,
  });
}

export interface EntryPatch {
  read?: boolean;
  bookmarked?: boolean;
  tags?: string[];
}

type EntriesCache = InfiniteData<EntriesResponse, string | null>;

function entryMatchesFilters(entry: Entry, filters: EntryFilters): boolean {
  if (filters.view === "unread" && entry.read) return false;
  if (filters.view === "saved" && !entry.bookmarked) return false;
  if (filters.tag && !entry.tags.includes(filters.tag)) return false;
  return true;
}

export function updateEntryCache(
  data: EntriesCache,
  filters: EntryFilters,
  id: number,
  patch: EntryPatch,
): EntriesCache {
  const pageIndex = data.pages.findIndex((page) =>
    page.entries.some((entry) => entry.id === id),
  );
  if (pageIndex === -1) return data;

  const page = data.pages[pageIndex];
  const entryIndex = page.entries.findIndex((entry) => entry.id === id);
  const entry = page.entries[entryIndex];
  const patchedEntry: Entry = {
    ...entry,
    read: patch.read ?? entry.read,
    bookmarked: patch.bookmarked ?? entry.bookmarked,
    tags: patch.tags ?? entry.tags,
  };
  const entries = page.entries.slice();
  if (entryMatchesFilters(patchedEntry, filters)) {
    entries[entryIndex] = patchedEntry;
  } else {
    entries.splice(entryIndex, 1);
  }
  const pages = data.pages.slice();
  pages[pageIndex] = { ...page, entries };

  return { ...data, pages };
}

/** Optimistically patch an entry across every cached river view. */
export function useEntryPatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: EntryPatch }) =>
      api<void>(`/entries/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ["entries"] });
      const snapshots = qc.getQueriesData<EntriesCache>({
        queryKey: ["entries"],
      });

      for (const [queryKey, data] of snapshots) {
        if (!data) continue;
        const filters = queryKey[1] as EntryFilters;
        qc.setQueryData(queryKey, updateEntryCache(data, filters, id, patch));
      }

      return { snapshots };
    },
    onError: (_error, _variables, context) => {
      for (const [queryKey, data] of context?.snapshots ?? []) {
        qc.setQueryData(queryKey, data);
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["feeds"] }),
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (scope: { feed_id?: number; group?: string; before?: string }) =>
      api<{ marked: number }>("/entries/mark-read", {
        method: "POST",
        body: JSON.stringify(scope),
      }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["entries"] });
      qc.invalidateQueries({ queryKey: ["feeds"] });
    },
  });
}

export function useSubscribe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { url: string; group?: string }) =>
      api<Feed>("/feeds", { method: "POST", body: JSON.stringify(body) }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["feeds"] });
      qc.invalidateQueries({ queryKey: ["entries"] });
    },
  });
}

export function useFeedPatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: { title?: string; group?: string } }) =>
      api<void>(`/feeds/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["feeds"] });
      qc.invalidateQueries({ queryKey: ["entries"] });
    },
  });
}

export function useUnsubscribe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<void>(`/feeds/${id}`, { method: "DELETE" }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["feeds"] });
      qc.invalidateQueries({ queryKey: ["entries"] });
    },
  });
}

export function useRefresh() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (feed_id?: number) =>
      api<void>("/feeds/refresh", { method: "POST", body: JSON.stringify({ feed_id }) }),
    onSettled: () => {
      // Give the sweep a moment before re-asking for counts.
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ["feeds"] });
        qc.invalidateQueries({ queryKey: ["entries"] });
      }, 3_000);
    },
  });
}

export function useImportOpml() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opml: string) =>
      api<{ added: number }>("/feeds/import", { method: "POST", body: opml }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["feeds"] });
      qc.invalidateQueries({ queryKey: ["entries"] });
    },
  });
}
