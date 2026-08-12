import { Checkbox, CheckboxGroup, Label } from "react-aria-components";
import type { ReferenceIssue, ReferenceIssueFilters } from "#/api/index";
import { Button } from "#/components/ui/button";
import { Select, SelectItem } from "#/components/ui/select";
import { TextField } from "#/components/ui/text-field";
import { KINDS, type Kind, kindLabel } from "#/lib/kind";

const ISSUE_KINDS: { id: ReferenceIssue["kind"]; label: string }[] = [
  { id: "unresolved_page_link", label: "Unresolved links" },
  { id: "ambiguous_page_link", label: "Ambiguous links" },
  { id: "broken_block_ref", label: "Broken blocks" },
  { id: "invalid_relation_target", label: "Invalid relations" },
  { id: "orphan_page", label: "Orphans" },
  { id: "isolated_page", label: "Isolated" },
];

const ACTIONABILITY_OPTIONS = [
  { id: "all", label: "All issues" },
  { id: "actionable", label: "Actionable only" },
  { id: "navigation", label: "Navigation only" },
] as const;

function FilterCheckbox({
  value,
  children,
}: {
  value: string;
  children: string;
}) {
  return (
    <Checkbox
      aria-label={children}
      value={value}
      className="group flex min-h-7 items-center gap-1.5 text-[10px] text-ink outline-none"
    >
      <span className="flex h-3.5 w-3.5 items-center justify-center border border-rule bg-paper group-data-[selected]:border-accent group-data-[selected]:bg-accent group-data-[focus-visible]:outline group-data-[focus-visible]:outline-2 group-data-[focus-visible]:outline-offset-2 group-data-[focus-visible]:outline-ring">
        <span className="hidden text-[9px] font-black text-primary-foreground group-data-[selected]:block">
          ✓
        </span>
      </span>
      {children}
    </Checkbox>
  );
}

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
      className="grid gap-3 border-b border-rule bg-paper-2 px-3 py-3 lg:grid-cols-[minmax(18rem,1.6fr)_minmax(9rem,0.8fr)_minmax(9rem,0.8fr)_minmax(9rem,0.8fr)_auto] lg:items-end"
    >
      <CheckboxGroup
        aria-label="Issue kinds"
        value={filters.kind ?? []}
        onChange={(kind) =>
          onChange({
            ...filters,
            kind: kind.length ? (kind as ReferenceIssue["kind"][]) : undefined,
          })
        }
        className="min-w-0"
      >
        <Label className="cl-mono text-[9px] uppercase tracking-[0.16em] text-ink-mute">
          Issue kinds
        </Label>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
          {ISSUE_KINDS.map((kind) => (
            <FilterCheckbox key={kind.id} value={kind.id}>
              {kind.label}
            </FilterCheckbox>
          ))}
        </div>
      </CheckboxGroup>

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
        items={[
          { id: "", label: "All page kinds" },
          ...KINDS.map((kind: Kind) => ({ id: kind, label: kindLabel(kind) })),
        ]}
        className="w-full"
      >
        {(item) => <SelectItem id={item.id}>{item.label}</SelectItem>}
      </Select>

      <Select
        label="Repairability"
        selectedKey={
          filters.actionable === true
            ? "actionable"
            : filters.actionable === false
              ? "navigation"
              : "all"
        }
        onSelectionChange={(key) =>
          onChange({
            ...filters,
            actionable:
              key === "actionable"
                ? true
                : key === "navigation"
                  ? false
                  : undefined,
          })
        }
        items={ACTIONABILITY_OPTIONS}
        className="w-full"
      >
        {(item) => <SelectItem id={item.id}>{item.label}</SelectItem>}
      </Select>

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
