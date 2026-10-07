import {
  createFileRoute,
  type SearchSchemaInput,
  useNavigate,
} from "@tanstack/react-router";
import { Gazetteer, type GazetteerFilters } from "#/components/codex/Gazetteer";
import {
  GAZETTEER_FILTER,
  type GazetteerSort,
  validateGazetteerSearch,
} from "#/components/codex/gazetteer-filter";
import { useFilterRoute } from "#/lib/filters/route";

export const Route = createFileRoute("/gazetteer")({
  staticData: { codexView: "gazetteer" },
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput) =>
    validateGazetteerSearch(search),
  component: GazetteerPage,
});

function GazetteerPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { filterState, onFilterChange } = useFilterRoute(
    GAZETTEER_FILTER,
    search,
  );
  const updateView = (
    patch: { sort?: GazetteerSort; page?: number },
    replace = false,
  ) =>
    navigate({
      to: "/gazetteer",
      search: (current) => ({
        ...current,
        sort: patch.sort ?? current.sort,
        page: patch.page ?? current.page,
      }),
      replace,
    });

  const filters: GazetteerFilters = {
    filterState,
    sort: search.sort,
    page: search.page,
    onFilterChange,
    onSortChange: (sort) => updateView({ sort, page: 1 }),
    onPageChange: (page, replace = false) => updateView({ page }, replace),
  };

  return <Gazetteer filters={filters} />;
}
