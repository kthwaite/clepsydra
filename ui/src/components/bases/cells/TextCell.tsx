import { useState } from "react";
import {
  CELL_INPUT_CLASS,
  type CellEditorProps,
  tabCommit,
  useInitialFocus,
} from "./types";

export function TextCell({
  value,
  onCommit,
  onCommitNext,
  onCommitPrevious,
  onCancel,
  ariaLabel,
  ariaDescribedBy,
  commitOnBlur,
}: CellEditorProps) {
  const [draft, setDraft] = useState(typeof value === "string" ? value : "");
  const inputRef = useInitialFocus<HTMLInputElement>();
  const commit = (submit: CellEditorProps["onCommit"] = onCommit) => {
    submit(draft === "" ? null : draft);
  };
  return (
    <input
      ref={inputRef}
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
        const tabSubmit = tabCommit(e, {
          commitOnBlur,
          onCommitNext,
          onCommitPrevious,
        });
        if (tabSubmit) {
          e.preventDefault();
          e.stopPropagation();
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
