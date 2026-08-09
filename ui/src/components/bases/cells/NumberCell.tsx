import { useState } from "react";
import { CELL_INPUT_CLASS, type CellEditorProps } from "./types";

export function NumberCell({
  value,
  onCommit,
  onCommitNext,
  onCancel,
}: CellEditorProps) {
  const [draft, setDraft] = useState(
    typeof value === "number" ? String(value) : "",
  );
  const commit = (
    submit: CellEditorProps["onCommit"] = onCommit,
  ): boolean => {
    if (draft === "") {
      submit(null);
      return true;
    }
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) return false;
    submit(parsed);
    return true;
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
