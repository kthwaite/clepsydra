import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Gazetteer, type GazetteerFilters } from "#/components/codex/Gazetteer";
import type { GazetteerSort } from "#/components/codex/gazetteer-filter";
import { KINDS, type Kind } from "#/lib/kind";

export type GazetteerSearch = Record<string, unknown> & {
  q?: string;
  tags?: string[];
  kind?: string;
  project?: string;
  sort: GazetteerSort;
  page: number;
};

type GazetteerSearchPatch = Partial<
  Pick<GazetteerSearch, "q" | "tags" | "kind" | "project" | "sort" | "page">
>;

const SORTS: GazetteerSort[] = ["ts", "id", "title", "words"];

export const Route = createFileRoute("/gazetteer")({
  validateSearch: (search: Record<string, unknown>): GazetteerSearch => {
    const rawTags = Array.isArray(search.tags)
      ? search.tags
      : typeof search.tags === "string"
        ? search.tags.split(",")
        : typeof search.tag === "string"
          ? [search.tag]
          : [];
    const tags = [
      ...new Set(
        rawTags
          .filter((tag): tag is string => typeof tag === "string")
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ];
    const rawKind =
      typeof search.kind === "string" ? search.kind.toUpperCase() : undefined;
    const kind = rawKind;
    const project =
      typeof search.project === "string" && search.project.trim()
        ? search.project.trim()
        : undefined;
    const sort = SORTS.includes(search.sort as GazetteerSort)
      ? (search.sort as GazetteerSort)
      : "ts";
    const page =
      typeof search.page === "number" &&
      Number.isFinite(search.page) &&
      search.page >= 1
        ? Math.floor(search.page)
        : 1;
    return {
      ...search,
      q:
        typeof search.q === "string" && search.q.length > 0
          ? search.q
          : undefined,
      tags: tags.length > 0 ? tags : undefined,
      kind,
      project,
      sort,
      page,
    };
  },
  component: GazetteerPage,
});

function GazetteerPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const updateSearch = (patch: GazetteerSearchPatch, resetPage = true) =>
    navigate({
      to: "/gazetteer",
      search: (current) => ({
        ...current,
        ...patch,
        sort:
          patch.sort ??
          (SORTS.includes(current.sort as GazetteerSort)
            ? (current.sort as GazetteerSort)
            : "ts"),
        page: resetPage
          ? 1
          : (patch.page ??
            (typeof current.page === "number" ? current.page : 1)),
      }),
    });

  const kind = KINDS.includes(search.kind as Kind)
    ? (search.kind as Kind)
    : undefined;

  const filters: GazetteerFilters = {
    query: search.q ?? "",
    selectedTags: search.tags ?? [],
    kind,
    queryKind: search.kind,
    project: search.project,
    sort: search.sort,
    page: search.page,
    onQueryChange: (q) => updateSearch({ q: q || undefined }),
    onSelectedTagsChange: (tags) =>
      updateSearch({ tags: tags.length > 0 ? tags : undefined }),
    onKindChange: (kind) => updateSearch({ kind }),
    onProjectChange: (project) => updateSearch({ project }),
    onSortChange: (sort) => updateSearch({ sort }),
    onPageChange: (page) => updateSearch({ page }, false),
  };

  return <Gazetteer filters={filters} />;
}
