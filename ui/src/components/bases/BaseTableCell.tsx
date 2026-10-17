import type { Ref } from "react";
import type { PropertyDefinition, PropertyType, QueryRow } from "#/api/bases";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { NumberDisplay } from "./cells/NumberDisplay";
import { type CellValue, formatCellValue } from "./cells/types";
import { EditableCell } from "./EditableCell";

/** System columns never acquire an inline property editor. */
export const SYSTEM_COLUMNS: Record<string, boolean> = {
  id: true,
  path: true,
  title: true,
  kind: true,
  project: true,
  body: false,
  tags: false,
  aliases: false,
  created_at: true,
  updated_at: true,
  journal_date: true,
  word_count: true,
};

export interface BaseTableCellProps {
  row: QueryRow;
  column: string;
  property?: PropertyDefinition;
  readOnly: boolean;
  draftOpen: boolean;
  titleRef?: Ref<HTMLButtonElement>;
  onOpenPage(path: string): void;
  suggestions?: string[];
  editing: boolean;
  onEdit(): void;
  onCancel(): void;
  onCommit(value: CellValue, hint?: PropertyType): void;
  onMove(value: CellValue, hint: PropertyType | undefined, step: 1 | -1): void;
}

export function BaseTableCell({
  row,
  column,
  property,
  readOnly,
  draftOpen,
  titleRef,
  onOpenPage,
  suggestions,
  editing,
  onEdit,
  onCancel,
  onCommit,
  onMove,
}: BaseTableCellProps) {
  if (column === "title") {
    return readOnly || draftOpen ? (
      <span className="block truncate px-1 py-0.5 text-[length:var(--title)] font-medium text-ink">
        {row.title ?? row.path}
      </span>
    ) : (
      <button
        ref={titleRef}
        type="button"
        data-row-title={row.id}
        className={cn(
          "cursor-pointer truncate rounded-md text-left text-[length:var(--title)] font-medium text-ink hover:text-accent",
          FOCUS_RING_NATIVE,
        )}
        onClick={() => onOpenPage(row.path)}
      >
        {row.title ?? row.path}
      </button>
    );
  }
  const value = (row.columns as Record<string, CellValue>)[column] ?? null;
  if (column === "body") {
    if (typeof value !== "string" || !value.trim()) return null;
    return (
      <button
        type="button"
        aria-label={`Open body excerpt for ${row.title ?? row.path} in Folio`}
        className={cn(
          "block w-full min-w-0 cursor-pointer truncate rounded-md px-1 py-0.5 text-left text-mute hover:text-accent text-wrap",
          FOCUS_RING_NATIVE,
        )}
        onClick={() => onOpenPage(row.path)}
      >
        {value}
      </button>
    );
  }
  if (
    !readOnly &&
    !draftOpen &&
    SYSTEM_COLUMNS[column] === undefined &&
    property
  ) {
    return (
      <EditableCell
        value={value}
        definition={property}
        suggestions={suggestions}
        isEditing={editing}
        onEdit={onEdit}
        onCancel={onCancel}
        onCommit={onCommit}
        onCommitNext={(next, hint) => onMove(next, hint, 1)}
        onCommitPrevious={(next, hint) => onMove(next, hint, -1)}
      />
    );
  }
  return (
    <span className="block truncate px-1 py-0.5 text-mute tabular-nums">
      {property?.type === "number" && typeof value === "number" ? (
        <NumberDisplay value={value} definition={property} />
      ) : (
        formatCellValue(value)
      )}
    </span>
  );
}
