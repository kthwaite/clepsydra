import { useState } from "react";
import { CELL_INPUT_CLASS, type CellEditorProps } from "./types";

export function NumberCell({
  value,
  onCommit,
  onCommitNext,
  onCancel,
  ariaLabel,
  ariaDescribedBy,
  commitOnBlur,
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
    // Reject a non-numeric commit without coercing it to a clear.
    if (!Number.isFinite(parsed)) return false;
    submit(parsed);
    return true;
  };
  return (
    <input
      autoFocus
      aria-label={ariaLabel ?? "Edit number"}
      aria-describedby={ariaDescribedBy}
      type="number"
      step="any"
      inputMode="decimal"
      className={CELL_INPUT_CLASS}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(event) => {
        if (commitOnBlur) {
          if (!event.currentTarget.validity.valid || !commit()) onCancel();
        } else {
          onCancel();
        }
      }}
      onKeyDown={(e) => {
        if (!commitOnBlur && e.key === "Tab" && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          if (!e.currentTarget.validity.valid) return;
          commit(onCommitNext);
          return;
        }
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
