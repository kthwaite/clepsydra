import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PageDetail, PageSummary, PaginatedResponse } from "./types";

async function fetchPages(): Promise<PaginatedResponse<PageSummary>> {
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

async function createPage(path: string): Promise<void> {
  const res = await fetch(`/api/vault/pages/${encodeURI(path)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`Failed to create page: ${res.status}`);
}

async function createFolder(path: string): Promise<void> {
  const res = await fetch(`/api/vault/folders/${encodeURI(path)}`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Failed to create folder: ${res.status}`);
}

export function useCreatePage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createPage,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pages"] }),
  });
}

export function useCreateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createFolder,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pages"] }),
  });
}
