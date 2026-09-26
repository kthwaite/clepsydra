import { ChevronDown } from "lucide-react";
import type { Key } from "react-aria-components";
import {
  Select as AriaSelect,
  Checkbox,
  CheckboxGroup,
  Input,
  Label,
  SelectValue,
  TextField,
} from "react-aria-components";
import type { ReferenceIssue, ReferenceIssueFilters } from "#/api/index";
import { Button } from "#/components/ui/button";
import { Popover } from "#/components/ui/popover";
import { SelectItem, SelectListBox } from "#/components/ui/select";
import { cn } from "#/lib/cn";
import { FOCUS_RING } from "#/lib/focusRing";
import { KINDS, type Kind, kindDisplayLabel } from "#/lib/kind";

const ISSUE_KINDS: { id: ReferenceIssue["kind"]; label: string }[] = [
  { id: "unresolved_page_link", label: "Unresolved links" },
  { id: "ambiguous_page_link", label: "Ambiguous links" },
  { id: "broken_block_ref", label: "Broken blocks" },
  { id: "invalid_relation_target", label: "Invalid relations" },
  { id: "orphan_page", label: "Orphans" },
  { id: "isolated_page", label: "Isolated" },
];

const ACTIONABILITY_OPTIONS = [
  { id: "all", label: "All" },
  { id: "actionable", label: "Actionable only" },
  { id: "navigation", label: "Navigation only" },
] as const;

const PAGE_KIND_OPTIONS = [
  { id: "", label: "All" },
  ...KINDS.map((kind: Kind) => ({ id: kind, label: kindDisplayLabel(kind) })),
];

/** An issue-kind toggle: a pill that tints cobalt when on. */
function FilterChip({ value, children }: { value: string; children: string }) {
  return (
    <Checkbox
      aria-label={children}
      value={value}
      className={cn(
        "flex h-8 cursor-pointer items-center rounded-full bg-sink px-3.5 text-[13.5px] text-ink-2 transition-colors data-[hovered]:bg-sink/70 data-[selected]:bg-accent-tint data-[selected]:text-accent",
        FOCUS_RING,
      )}
    >
      {children}
    </Checkbox>
  );
}

/** A compact "Label · value" select trigger, as in the Repairs mockup. */
function FilterSelect<T extends { id: string; label: string }>({
  label,
  items,
  selectedKey,
  onSelectionChange,
}: {
  label: string;
  items: readonly T[];
  selectedKey: string;
  onSelectionChange: (key: Key | null) => void;
}) {
  return (
    <AriaSelect
      selectedKey={selectedKey}
      onSelectionChange={onSelectionChange}
      className="relative"
    >
      <Label className="sr-only">{label}</Label>
      <Button variant="ghost" size="sm" className="gap-1.5 px-3 text-ink">
        <span aria-hidden>{label} ·</span>
        <SelectValue className="max-w-40 truncate" />
        <ChevronDown aria-hidden className="size-3.5 text-mute" />
      </Button>
      <Popover
        hideArrow
        className="min-w-(--trigger-width) rounded-xl bg-raise text-ink shadow-lg"
      >
        <SelectListBox items={items}>
          {(item) => <SelectItem id={item.id}>{item.label}</SelectItem>}
        </SelectListBox>
      </Popover>
    </AriaSelect>
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
      className="flex flex-wrap items-center gap-2 px-4 pt-5 md:px-10"
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
        className="flex min-w-0 flex-wrap gap-1.5"
      >
        {ISSUE_KINDS.map((kind) => (
          <FilterChip key={kind.id} value={kind.id}>
            {kind.label}
          </FilterChip>
        ))}
      </CheckboxGroup>

      <span aria-hidden className="hidden flex-1 lg:block" />

      <TextField
        value={filters.project ?? ""}
        onChange={(project) =>
          onChange({ ...filters, project: project || undefined })
        }
        className="flex h-8 items-center gap-2 rounded-full bg-sink pl-3.5 pr-2 text-[13.5px] text-mute focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-2 focus-within:ring-offset-ground"
      >
        <Label>Project</Label>
        <Input
          placeholder="All"
          className="w-24 min-w-0 bg-transparent text-ink outline-none placeholder:text-mute"
        />
      </TextField>

      <FilterSelect
        label="Page kind"
        items={PAGE_KIND_OPTIONS}
        selectedKey={filters.pageKind ?? ""}
        onSelectionChange={(key) =>
          onChange({
            ...filters,
            pageKind: typeof key === "string" && key ? key : undefined,
          })
        }
      />

      <FilterSelect
        label="Repairability"
        items={ACTIONABILITY_OPTIONS}
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
      />

      <Button
        size="sm"
        variant="ghost"
        aria-label="Clear filters"
        isDisabled={!hasFilters}
        onPress={() => onChange({})}
        className="text-accent data-[hovered]:text-accent"
      >
        Clear
      </Button>
    </section>
  );
}
