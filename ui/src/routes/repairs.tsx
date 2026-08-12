import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { ReferenceIssue, ReferenceIssueFilters } from "#/api/index";
import { RepairWorkspace } from "#/components/repairs/RepairWorkspace";

const REPAIR_KINDS = new Set<ReferenceIssue["kind"]>([
  "unresolved_page_link",
  "ambiguous_page_link",
  "broken_block_ref",
  "invalid_relation_target",
  "orphan_page",
  "isolated_page",
]);

export interface RepairSearch {
  target?: string;
  kind?: ReferenceIssue["kind"][];
  project?: string;
  pageKind?: string;
  actionable?: boolean;
}

export function parseRepairSearch(search: Record<string, unknown>): RepairSearch {
  const rawKinds = Array.isArray(search.kind)
    ? search.kind
    : typeof search.kind === "string"
      ? search.kind.split(",")
      : [];
  const kind = rawKinds.filter(
    (value): value is ReferenceIssue["kind"] =>
      typeof value === "string" &&
      REPAIR_KINDS.has(value as ReferenceIssue["kind"]),
  );
  return {
    target:
      typeof search.target === "string" && search.target
        ? search.target
        : undefined,
    kind: kind.length ? kind : undefined,
    project:
      typeof search.project === "string" && search.project
        ? search.project
        : undefined,
    pageKind:
      typeof search.pageKind === "string" && search.pageKind
        ? search.pageKind
        : undefined,
    actionable:
      search.actionable === true || search.actionable === "true"
        ? true
        : search.actionable === false || search.actionable === "false"
          ? false
          : undefined,
  };
}

export function repairFiltersToSearch(
  current: RepairSearch,
  filters: ReferenceIssueFilters,
): RepairSearch {
  return {
    target: current.target,
    kind: filters.kind?.length ? filters.kind : undefined,
    project: filters.project || undefined,
    pageKind: filters.pageKind || undefined,
    actionable: filters.actionable,
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
