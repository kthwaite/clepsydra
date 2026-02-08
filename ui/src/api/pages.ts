import { useQuery } from "@tanstack/react-query";
import type { PageDetail, PageSummary } from "./types";

async function fetchPages(): Promise<PageSummary[]> {
  const res = await fetch("/api/vault/pages");
  if (!res.ok) throw new Error(`Failed to fetch pages: ${res.status}`);
  return res.json();
}

async function fetchPage(path: string): Promise<PageDetail> {
  const res = await fetch(`/api/vault/pages/${encodeURI(path)}`);
  if (!res.ok) throw new Error(`Failed to fetch page: ${res.status}`);
  return res.json();
}

export function usePages() {
  return useQuery({
    queryKey: ["pages"],
    queryFn: fetchPages,
  });
}

export function usePage(path: string) {
  return useQuery({
    queryKey: ["pages", path],
    queryFn: () => fetchPage(path),
    enabled: !!path,
  });
}
