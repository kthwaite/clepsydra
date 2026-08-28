// The PERSON pages a meeting can name, and the create path for one that does
// not exist yet. Names resolve the way the editor resolves a `[[wikilink]]`
// (title, canonical name, path, or alias — see wikilinkIdentity.ts), so the
// rail and the body agree on which page an attendee is.

import { useCallback, useMemo } from "react";
import { useCreatePage, usePages } from "#/api/pages";
import type { PageSummary } from "#/api/types";
import { pageHasExactWikilinkIdentity } from "#/editor/wikilinkIdentity";
import { generateShortId, intakePath } from "#/lib/intake";

/** The name a page is linked by: its title, else its canonical name. */
export const pageName = (page: PageSummary): string =>
  page.title ?? page.canonical_name;

/** The page a `[[name]]` identifies, or null. A PERSON page wins over
 * another kind carrying the same name. */
export function findPageByName(
  pages: readonly PageSummary[],
  name: string,
): PageSummary | null {
  let fallback: PageSummary | null = null;
  for (const page of pages) {
    if (!pageHasExactWikilinkIdentity(page, name)) continue;
    if (page.kind === "PERSON") return page;
    fallback ??= page;
  }
  return fallback;
}

/** Every indexed page, for resolving attendee names. */
export function useIndexedPages(): PageSummary[] {
  const { data } = usePages();
  return data?.items ?? EMPTY;
}

const EMPTY: PageSummary[] = [];

/** PERSON pages, sorted by name. */
export function usePeople(): PageSummary[] {
  const pages = useIndexedPages();
  return useMemo(
    () =>
      pages
        .filter((page) => page.kind === "PERSON")
        .sort((a, b) => pageName(a).localeCompare(pageName(b))),
    [pages],
  );
}

/** Create a PERSON page titled `title` at its intake path. Resolves to the
 * created page's path. */
export function useCreatePerson(): (title: string) => Promise<string> {
  const create = useCreatePage();
  const mutateAsync = create.mutateAsync;
  return useCallback(
    async (title: string) => {
      const path = intakePath({
        kind: "PERSON",
        project: null,
        title,
        shortId: generateShortId(),
        now: new Date(),
      });
      const data = await mutateAsync({
        params: { path: { path } },
        body: { title, kind: "PERSON" },
      });
      return data.path ?? path;
    },
    [mutateAsync],
  );
}
