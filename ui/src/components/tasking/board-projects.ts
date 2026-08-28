/**
 * Project scopes for the Tasking board.
 *
 * The Scope rail, timeline grouping, and project selects need one project
 * list. Board `operations` (PROJECT pages) only cover projects that have a
 * page; tasks can carry a `project` slug that no page backs. A ProjectScope
 * unifies both: one per operation, plus one synthesized per task slug that
 * matches no operation key.
 */

import type { BoardOperation, BoardTask } from "#/api/board";
import { opKey } from "./board-constants";

/** One Scope-rail project row: a board operation, or a synthesized entry. */
export interface ProjectScope {
  /** opFilter value: the project slug, or op.code for a slug-less op. */
  key: string;
  /** Project slug; null only for a slug-less op. */
  slug: string | null;
  /** op.code, or slug.toUpperCase() when synthesized. */
  code: string;
  /** op.name, or "" when synthesized. */
  name: string;
  /** op.health, or null when synthesized (no page → no health claim). */
  health: string | null;
  /** Backing operation; null when synthesized from task slugs. */
  op: BoardOperation | null;
}

/**
 * Derive project scopes from board operations plus every distinct task
 * `project` slug that no operation key already covers. Sorted by `code` in
 * byte order, matching the server's operation sort.
 */
export function deriveProjectScopes(
  operations: BoardOperation[],
  tasks: BoardTask[],
): ProjectScope[] {
  const scopes: ProjectScope[] = operations.map((op) => ({
    key: opKey(op),
    slug: op.project ?? null,
    code: op.code,
    name: op.name,
    health: op.health,
    op,
  }));

  const known = new Set(scopes.map((s) => s.key));
  for (const task of tasks) {
    const slug = task.project;
    if (!slug || known.has(slug)) continue;
    known.add(slug);
    scopes.push({
      key: slug,
      slug,
      code: slug.toUpperCase(),
      name: "",
      health: null,
      op: null,
    });
  }

  return scopes.sort((a, b) =>
    a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );
}

/** "CODE — name" for an operation-backed scope, "CODE" when name is empty. */
export function scopeLabel(scope: ProjectScope): string {
  return scope.name ? `${scope.code} — ${scope.name}` : scope.code;
}
