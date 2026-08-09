import { useState } from "react";
import { CELL_INPUT_CLASS, type CellEditorProps } from "./types";

export function NumberCell({
  value,
  onCommit,
  onCancel,
  ariaLabel,
  ariaDescribedBy,
}: CellEditorProps) {
  const [draft, setDraft] = useState(
    typeof value === "number" ? String(value) : "",
  );
  const commit = () => {
    if (draft === "") {
      onCommit(null);
      return;
    }
    const parsed = Number(draft);
    // Reject a non-numeric commit: stay in the editor.
    if (Number.isFinite(parsed)) onCommit(parsed);
  };
  return (
    <input
      autoFocus
      aria-label={ariaLabel ?? "Edit number"}
      aria-describedby={ariaDescribedBy}
      type="number"
      inputMode="decimal"
      className={CELL_INPUT_CLASS}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={onCancel}
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
