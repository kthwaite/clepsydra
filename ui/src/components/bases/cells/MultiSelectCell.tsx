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
  onCommitNext,
  onCancel,
}: CellEditorProps) {
  const initial = currentValues(value);
  const [selected, setSelected] = useState<string[]>(initial);
  const commit = (submit: CellEditorProps["onCommit"] = onCommit) => {
    submit(selected.length === 0 ? null : selected);
  };

  // Open vocabulary (or novel values on disk): keep them selectable.
  const options = [
    ...(definition.options ?? []),
    ...initial.filter((v) => !(definition.options ?? []).includes(v)),
  ];

  return (
    <select
      autoFocus
      multiple
      aria-label="Edit multi-select"
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
        if (e.key === "Tab" && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          commit(onCommitNext);
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") onCancel();
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
