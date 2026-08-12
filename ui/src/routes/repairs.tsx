import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { ReferenceIssue, ReferenceIssueFilters } from "#/api/index";
import { RepairWorkspace } from "#/components/repairs/RepairWorkspace";
import { KINDS, type Kind } from "#/lib/kind";

const REPAIR_KINDS: Record<ReferenceIssue["kind"], true> = {
  unresolved_page_link: true,
  ambiguous_page_link: true,
  broken_block_ref: true,
  invalid_relation_target: true,
  orphan_page: true,
  isolated_page: true,
};
const PAGE_LIMIT = 100;

export interface RepairSearch {
  target?: string;
  kind?: ReferenceIssue["kind"][];
  project?: string;
  pageKind?: Kind;
  actionable?: boolean;
  limit?: number;
  offset?: number;
}

export function parseRepairSearch(search: Record<string, unknown>): RepairSearch {
  const rawKinds = Array.isArray(search.kind)
    ? search.kind
    : typeof search.kind === "string"
      ? search.kind.split(",")
      : [];
  const kind = rawKinds.filter(
    (value): value is ReferenceIssue["kind"] =>
      Object.hasOwn(REPAIR_KINDS, value),
  );
  const result: RepairSearch = {};
  if (typeof search.target === "string" && search.target) {
    result.target = search.target;
  }
  if (kind.length) result.kind = kind;
  if (typeof search.project === "string" && search.project) {
    result.project = search.project;
  }
  if (
    typeof search.pageKind === "string" &&
    KINDS.some((kind) => kind === search.pageKind)
  ) {
    result.pageKind = search.pageKind as Kind;
  }
  if (search.actionable === true || search.actionable === "true") {
    result.actionable = true;
  } else if (search.actionable === false || search.actionable === "false") {
    result.actionable = false;
  }
  const offset =
    typeof search.offset === "number"
      ? search.offset
      : typeof search.offset === "string"
        ? Number(search.offset)
        : undefined;
  if (offset !== undefined && Number.isInteger(offset) && offset >= 0) {
    result.offset = offset;
  }
  const limit =
    typeof search.limit === "number"
      ? search.limit
      : typeof search.limit === "string"
        ? Number(search.limit)
        : undefined;
  if (limit === PAGE_LIMIT) result.limit = PAGE_LIMIT;
  return result;
}

export function repairFiltersToSearch(
  current: RepairSearch,
  filters: ReferenceIssueFilters,
): RepairSearch {
  const pageKind = KINDS.find((kind) => kind === filters.pageKind);
  return {
    target: current.target,
    kind: filters.kind?.length ? filters.kind : undefined,
    project: filters.project || undefined,
    pageKind,
    actionable: filters.actionable,
    limit: filters.limit,
    offset: filters.offset,
  };
}

export const Route = createFileRoute("/repairs")({
  validateSearch: parseRepairSearch,
  component: RepairsPage,
});

function RepairsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/repairs" });
  const filters: ReferenceIssueFilters = {
    kind: search.kind,
    project: search.project,
    pageKind: search.pageKind,
    actionable: search.actionable,
    limit: search.limit ?? PAGE_LIMIT,
    offset: search.offset ?? 0,
  };

  return (
    <RepairWorkspace
      target={search.target}
      filters={filters}
      onFiltersChange={(next) =>
        void navigate({
          replace: true,
          search: (current) => repairFiltersToSearch(current, next),
        })
      }
    />
  );
}
