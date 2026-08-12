import { Checkbox } from "react-aria-components";
import type { ReferenceIssue, ReferenceIssueFilters } from "#/api/index";
import { Button } from "#/components/ui/button";
import { Select, SelectItem } from "#/components/ui/select";
import { TextField } from "#/components/ui/text-field";

const KIND_OPTIONS: { id: ReferenceIssue["kind"] | ""; label: string }[] = [
  { id: "", label: "All issue kinds" },
  { id: "unresolved_page_link", label: "Unresolved page links" },
  { id: "ambiguous_page_link", label: "Ambiguous page links" },
  { id: "broken_block_ref", label: "Broken block references" },
  { id: "invalid_relation_target", label: "Invalid relation targets" },
  { id: "orphan_page", label: "Orphan pages" },
  { id: "isolated_page", label: "Isolated pages" },
];

const PAGE_KIND_OPTIONS = [
  { id: "", label: "All page kinds" },
  { id: "NOTE", label: "Note" },
  { id: "PROJECT", label: "Project" },
  { id: "JOURNAL", label: "Journal" },
  { id: "TASK", label: "Task" },
  { id: "AI_CONVERSATION", label: "AI conversation" },
];

export interface RepairFiltersProps {
  filters: ReferenceIssueFilters;
  onChange: (filters: ReferenceIssueFilters) => void;
}

export function RepairFilters({ filters, onChange }: RepairFiltersProps) {
  const hasFilters = Boolean(
    filters.kind?.length ||
      filters.project ||
      filters.pageKind ||
      filters.actionable !== undefined,
  );

  return (
    <section
      aria-label="Repair filters"
      className="grid gap-3 border-b border-rule bg-paper-2 px-3 py-3 sm:grid-cols-2 lg:grid-cols-[minmax(11rem,1fr)_minmax(9rem,0.8fr)_minmax(9rem,0.8fr)_auto_auto] lg:items-end"
    >
      <Select
        label="Issue kind"
        selectedKey={filters.kind?.[0] ?? ""}
        onSelectionChange={(key) =>
          onChange({
            ...filters,
            kind: key ? [key as ReferenceIssue["kind"]] : undefined,
          })
        }
        items={KIND_OPTIONS}
        className="w-full"
      >
        {(item) => <SelectItem id={item.id}>{item.label}</SelectItem>}
      </Select>

      <TextField
        label="Project"
        value={filters.project ?? ""}
        onChange={(project) =>
          onChange({ ...filters, project: project || undefined })
        }
        placeholder="All projects"
        className="w-full"
      />

      <Select
        label="Page kind"
        selectedKey={filters.pageKind ?? ""}
        onSelectionChange={(key) =>
          onChange({
            ...filters,
            pageKind: typeof key === "string" && key ? key : undefined,
          })
        }
        items={PAGE_KIND_OPTIONS}
        className="w-full"
      >
        {(item) => <SelectItem id={item.id}>{item.label}</SelectItem>}
      </Select>

      <Checkbox
        aria-label="Actionable only"
        isSelected={filters.actionable === true}
        onChange={(isSelected) =>
          onChange({
            ...filters,
            actionable: isSelected ? true : undefined,
          })
        }
        className="group flex min-h-8 items-center gap-2 text-xs text-ink outline-none"
      >
        <span className="flex h-4 w-4 items-center justify-center border border-rule bg-paper group-data-[selected]:border-accent group-data-[selected]:bg-accent group-data-[focus-visible]:outline group-data-[focus-visible]:outline-2 group-data-[focus-visible]:outline-offset-2 group-data-[focus-visible]:outline-ring">
          <span className="hidden text-[10px] font-black text-primary-foreground group-data-[selected]:block">
            ✓
          </span>
        </span>
        Actionable only
      </Checkbox>

      <Button
        size="sm"
        variant="ghost"
        isDisabled={!hasFilters}
        onPress={() => onChange({})}
      >
        Clear filters
      </Button>
    </section>
  );
}
