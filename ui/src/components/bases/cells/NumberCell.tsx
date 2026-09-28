import { useState } from "react";
import {
  CELL_INPUT_CLASS,
  type CellEditorProps,
  tabCommit,
  useInitialFocus,
} from "./types";

export function NumberCell({
  value,
  onCommit,
  onCommitNext,
  onCommitPrevious,
  onCancel,
  ariaLabel,
  ariaDescribedBy,
  commitOnBlur,
}: CellEditorProps) {
  const [draft, setDraft] = useState(
    typeof value === "number" ? String(value) : "",
  );
  const inputRef = useInitialFocus<HTMLInputElement>();
  const commit = (submit: CellEditorProps["onCommit"] = onCommit): boolean => {
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
      ref={inputRef}
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
        const tabSubmit = tabCommit(e, {
          commitOnBlur,
          onCommitNext,
          onCommitPrevious,
        });
        if (tabSubmit) {
          e.preventDefault();
          e.stopPropagation();
          if (!e.currentTarget.validity.valid) return;
          commit(tabSubmit);
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
