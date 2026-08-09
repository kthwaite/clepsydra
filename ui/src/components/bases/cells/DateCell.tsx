import { useState } from "react";
import { CELL_INPUT_CLASS, type CellEditorProps } from "./types";

export function DateCell({
  value,
  definition,
  onCommit,
  onCancel,
  ariaLabel,
  ariaDescribedBy,
  commitOnBlur,
}: CellEditorProps) {
  const [draft, setDraft] = useState(typeof value === "string" ? value : "");
  const commit = () => {
    if (draft === "") {
      onCommit(null);
      return;
    }
    // The ISO value ships with a `types` hint so the backend writes a
    // native TOML date rather than a quoted string.
    onCommit(draft, definition.type);
  };
  return (
    <input
      autoFocus
      aria-label={ariaLabel ?? "Edit date"}
      aria-describedby={ariaDescribedBy}
      type="date"
      className={CELL_INPUT_CLASS}
      value={draft.slice(0, 10)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commitOnBlur ? commit : onCancel}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}
