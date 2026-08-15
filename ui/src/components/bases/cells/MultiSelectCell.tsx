import { useState } from "react";
import { Select, SelectItem } from "#/components/ui/select";
import type { CellEditorProps } from "./types";

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
  ariaLabel,
  ariaDescribedBy,
  commitOnBlur,
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
  const choices = options.map((option, index) => ({
    id: `option-${index}`,
    value: option,
  }));
  const selectedIds = choices
    .filter((choice) => selected.includes(choice.value))
    .map((choice) => choice.id);

  return (
    <div
      onKeyDownCapture={(event) => {
        if (!commitOnBlur && event.key === "Tab" && !event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          commit(onCommitNext);
          return;
        }
        if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <Select
        autoFocus
        selectionMode="multiple"
        aria-label={ariaLabel ?? "Edit multi-select"}
        aria-describedby={ariaDescribedBy}
        value={selectedIds}
        onChange={(keys) => {
          setSelected(
            choices
              .filter((choice) => keys.includes(choice.id))
              .map((choice) => choice.value),
          );
        }}
        onBlur={() => {
          if (commitOnBlur) {
            commit();
          } else {
            onCancel();
          }
        }}
      >
        {choices.map((choice) => (
          <SelectItem key={choice.id} id={choice.id}>
            {choice.value}
          </SelectItem>
        ))}
      </Select>
    </div>
  );
}
