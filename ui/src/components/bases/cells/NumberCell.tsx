import { useState } from "react";
import { CELL_INPUT_CLASS, type CellEditorProps } from "./types";

export function NumberCell({ value, onCommit, onCancel }: CellEditorProps) {
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
      aria-label="Edit number"
      inputMode="decimal"
      className={CELL_INPUT_CLASS}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onCancel();
      }}
    />
  );
}
