import {
  createFileRoute,
  type SearchSchemaInput,
  useNavigate,
} from "@tanstack/react-router";
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
  staticData: { codexView: "gazetteer" },
  validateSearch: (
    search: Record<string, unknown> & SearchSchemaInput,
  ): GazetteerSearch => {
    // Cast to Record to allow direct function calls in tests
    const s = search as Record<string, unknown>;
    const rawTags = Array.isArray(s.tags)
      ? s.tags
      : typeof s.tags === "string"
        ? s.tags.split(",")
        : typeof s.tag === "string"
          ? [s.tag]
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
      typeof s.kind === "string" ? s.kind.toUpperCase() : undefined;
    const kind = rawKind;
    const project =
      typeof s.project === "string" && s.project.trim()
        ? s.project.trim()
        : undefined;
    const sort = SORTS.includes(s.sort as GazetteerSort)
      ? (s.sort as GazetteerSort)
      : "ts";
    const page =
      typeof s.page === "number" && Number.isFinite(s.page) && s.page >= 1
        ? Math.floor(s.page)
        : 1;
    return {
      ...s,
      q: typeof s.q === "string" && s.q.length > 0 ? s.q : undefined,
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
