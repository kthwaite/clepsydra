import { useQuery } from "@tanstack/react-query";
import type {
  BacklinkEntry,
  GraphResponse,
  TagCount,
  VaultStats,
} from "./types";

async function fetchBacklinks(path: string): Promise<BacklinkEntry[]> {
  const res = await fetch(`/api/vault/index/backlinks/${encodeURI(path)}`);
  if (!res.ok) throw new Error(`Failed to fetch backlinks: ${res.status}`);
  return res.json();
}

async function fetchTags(): Promise<TagCount[]> {
  const res = await fetch("/api/vault/index/tags");
  if (!res.ok) throw new Error(`Failed to fetch tags: ${res.status}`);
  return res.json();
}

async function fetchStats(): Promise<VaultStats> {
  const res = await fetch("/api/vault/index/stats");
  if (!res.ok) throw new Error(`Failed to fetch stats: ${res.status}`);
  return res.json();
}

async function fetchGraph(): Promise<GraphResponse> {
  const res = await fetch("/api/vault/index/graph");
  if (!res.ok) throw new Error(`Failed to fetch graph: ${res.status}`);
  return res.json();
}

export function useBacklinks(path: string) {
  return useQuery({
    queryKey: ["index", "backlinks", path],
    queryFn: () => fetchBacklinks(path),
    enabled: !!path,
  });
}

export function useTags() {
  return useQuery({
    queryKey: ["index", "tags"],
    queryFn: fetchTags,
  });
}

export function useStats() {
  return useQuery({
    queryKey: ["index", "stats"],
    queryFn: fetchStats,
  });
}

export function useGraph() {
  return useQuery({
    queryKey: ["index", "graph"],
    queryFn: fetchGraph,
  });
}
