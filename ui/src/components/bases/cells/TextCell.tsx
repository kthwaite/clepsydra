import { useState } from "react";
import { CELL_INPUT_CLASS, type CellEditorProps } from "./types";

export function TextCell({ value, onCommit, onCancel }: CellEditorProps) {
  const [draft, setDraft] = useState(typeof value === "string" ? value : "");
  return (
    <input
      autoFocus
      aria-label="Edit text"
      className={CELL_INPUT_CLASS}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(draft === "" ? null : draft);
        if (e.key === "Escape") onCancel();
      }}
    />
  );
}
