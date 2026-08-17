import {
  createFileRoute,
  type SearchSchemaInput,
  useNavigate,
} from "@tanstack/react-router";
import { Gazetteer, type GazetteerFilters } from "#/components/codex/Gazetteer";
import type { GazetteerSort } from "#/components/codex/gazetteer-filter";
import type { FilterState } from "#/lib/filters/model";

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

  const filterState: FilterState = {
    text: search.q ?? "",
    facets: {
      ...(search.tags?.length ? { tags: search.tags } : {}),
      ...(search.kind ? { kind: [search.kind] } : {}),
      ...(search.project ? { project: [search.project] } : {}),
    },
  };
  const onFilterChange = (next: FilterState) =>
    updateSearch({
      q: next.text || undefined,
      tags: next.facets.tags?.length ? [...next.facets.tags] : undefined,
      kind: next.facets.kind?.[0],
      project: next.facets.project?.[0],
    }); // updateSearch already resets page to 1

  const filters: GazetteerFilters = {
    filterState,
    sort: search.sort,
    page: search.page,
    onFilterChange,
    onSortChange: (sort) => updateSearch({ sort }),
    onPageChange: (page) => updateSearch({ page }, false),
  };

  return <Gazetteer filters={filters} />;
}
