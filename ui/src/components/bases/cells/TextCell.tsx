import { useState } from "react";
import { CELL_INPUT_CLASS, type CellEditorProps } from "./types";

export function TextCell({
  value,
  onCommit,
  onCancel,
  ariaLabel,
  ariaDescribedBy,
  commitOnBlur,
}: CellEditorProps) {
  const [draft, setDraft] = useState(typeof value === "string" ? value : "");
  return (
    <input
      autoFocus
      aria-label={ariaLabel ?? "Edit text"}
      aria-describedby={ariaDescribedBy}
      className={CELL_INPUT_CLASS}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (commitOnBlur) onCommit(draft === "" ? null : draft);
        else onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          onCommit(draft === "" ? null : draft);
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}
