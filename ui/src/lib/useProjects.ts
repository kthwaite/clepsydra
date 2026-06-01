import { usePages } from "#/api/pages";

export function distinctProjects(
  items: Array<{ project?: string | null }>,
): string[] {
  const set = new Set<string>();
  for (const it of items) {
    if (it.project) set.add(it.project);
  }
  return [...set].sort();
}

export function useProjects(): string[] {
  const { data } = usePages();
  return distinctProjects(data?.items ?? []);
}
