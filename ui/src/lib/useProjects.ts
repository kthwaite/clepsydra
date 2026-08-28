import { usePages } from "#/api/pages";

/** Every distinct `project` value pages carry, orphans included. */
export function distinctProjects(
  items: Array<{ project?: string | null }>,
): string[] {
  const set = new Set<string>();
  for (const it of items) {
    if (it.project) set.add(it.project);
  }
  return [...set].sort();
}

/** The slugs PROJECT pages declare — the only projects a page may join. */
export function declaredProjects(
  items: Array<{ kind?: string | null; project?: string | null }>,
): string[] {
  return distinctProjects(items.filter((it) => it.kind === "PROJECT"));
}

/** Projects a page may be assigned to: those a PROJECT page declares. */
export function useProjects(): string[] {
  const { data } = usePages();
  return declaredProjects(data?.items ?? []);
}

/** Projects pages actually carry, for filters — orphan slugs stay findable. */
export function useProjectValues(): string[] {
  const { data } = usePages();
  return distinctProjects(data?.items ?? []);
}
