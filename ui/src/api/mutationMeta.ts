/** `meta` for mutations that save nothing to the vault (previews, searches,
 *  fetches). The footer's save status ignores them, so it never claims a
 *  save that did not happen. */
export const NO_SAVE = { noSave: true } as const;

export function savesNothing(meta: Record<string, unknown> | undefined) {
  return meta?.noSave === true;
}
