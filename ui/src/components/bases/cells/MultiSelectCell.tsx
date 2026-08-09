import { useState } from "react";
import { CELL_INPUT_CLASS, type CellEditorProps } from "./types";

function currentValues(value: CellEditorProps["value"]): string[] {
  if (typeof value === "string") return value === "" ? [] : [value];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return [];
}

/**
 * Multi-select editor: toggles memberships while preserving the rest of the
 * array — a commit always carries the complete value set, never a single
 * chosen option. Enter commits, Escape/blur cancels.
 */
export function MultiSelectCell({
  value,
  definition,
  onCommit,
  onCancel,
  ariaLabel,
  ariaDescribedBy,
}: CellEditorProps) {
  const initial = currentValues(value);
  const [selected, setSelected] = useState<string[]>(initial);

  // Open vocabulary (or novel values on disk): keep them selectable.
  const options = [
    ...(definition.options ?? []),
    ...initial.filter((v) => !(definition.options ?? []).includes(v)),
  ];

  return (
    <select
      autoFocus
      multiple
      aria-label={ariaLabel ?? "Edit multi-select"}
      aria-describedby={ariaDescribedBy}
      size={Math.min(6, Math.max(2, options.length))}
      className={CELL_INPUT_CLASS}
      value={selected}
      onChange={(e) =>
        setSelected(
          Array.from(e.target.selectedOptions).map((option) => option.value),
        )
      }
      onBlur={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          onCommit(selected.length === 0 ? null : selected);
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}
