import { useState } from "react";
import { CELL_INPUT_CLASS, type CellEditorProps } from "./types";

export function DateCell({
  value,
  definition,
  onCommit,
  onCommitNext,
  onCancel,
}: CellEditorProps) {
  const [draft, setDraft] = useState(typeof value === "string" ? value : "");
  const commit = (submit: CellEditorProps["onCommit"] = onCommit) => {
    if (draft === "") {
      submit(null);
      return;
    }
    // The ISO value ships with a `types` hint so the backend writes a
    // native TOML date rather than a quoted string.
    submit(draft, definition.type);
  };
  return (
    <input
      autoFocus
      aria-label="Edit date"
      type="date"
      className={CELL_INPUT_CLASS}
      value={draft.slice(0, 10)}
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
