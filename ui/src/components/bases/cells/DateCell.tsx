import { useState } from "react";
import {
  CELL_INPUT_CLASS,
  type CellEditorProps,
  useInitialFocus,
} from "./types";

export function DateCell({
  value,
  definition,
  onCommit,
  onCommitNext,
  onCancel,
  ariaLabel,
  ariaDescribedBy,
  commitOnBlur,
}: CellEditorProps) {
  const [draft, setDraft] = useState(typeof value === "string" ? value : "");
  const inputRef = useInitialFocus<HTMLInputElement>();
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
      ref={inputRef}
      aria-label={ariaLabel ?? "Edit date"}
      aria-describedby={ariaDescribedBy}
      type="date"
      className={CELL_INPUT_CLASS}
      value={draft.slice(0, 10)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (commitOnBlur) commit();
        else onCancel();
      }}
      onKeyDown={(e) => {
        if (!commitOnBlur && e.key === "Tab" && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
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
