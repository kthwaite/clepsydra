import { useState } from "react";
import { CELL_INPUT_CLASS, type CellEditorProps } from "./types";

export function TextCell({
  value,
  onCommit,
  onCommitNext,
  onCancel,
}: CellEditorProps) {
  const [draft, setDraft] = useState(typeof value === "string" ? value : "");
  const commit = (submit: CellEditorProps["onCommit"] = onCommit) => {
    submit(draft === "" ? null : draft);
  };
  return (
    <input
      autoFocus
      aria-label="Edit text"
      className={CELL_INPUT_CLASS}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Tab" && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          commit(onCommitNext);
          return;
        }
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onCancel();
      }}
    />
  );
}
