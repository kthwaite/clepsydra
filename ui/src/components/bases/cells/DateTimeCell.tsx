import { useState } from "react";
import {
  CELL_INPUT_CLASS,
  type CellEditorProps,
  useInitialFocus,
} from "./types";

/**
 * Give a datetime-local value its seconds. Browsers drop `:00` seconds from
 * `<input type="datetime-local">` even at `step={1}`, and `2026-08-28T09:30`
 * is not a TOML date-time — the frontmatter splice would silently fall back to
 * storing a quoted string, which no date filter or sort can see.
 */
function withSeconds(local: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) ? `${local}:00` : local;
}

/** Split an ISO date-time into a datetime-local value and its zone suffix. */
function splitIso(value: string): { local: string; suffix: string } {
  const match = value.match(/^(.*?)(Z|[+-]\d{2}:\d{2})?$/);
  const body = match?.[1] ?? value;
  const suffix = match?.[2] ?? "";
  // datetime-local wants YYYY-MM-DDTHH:MM(:SS); pad a bare date.
  const local = body.includes("T") ? body : body ? `${body}T00:00:00` : "";
  return { local, suffix };
}

/**
 * The datetime editor keeps what `<input type="date">` would throw away:
 * the time component and the original zone suffix both survive the edit.
 */
export function DateTimeCell({
  value,
  definition,
  onCommit,
  onCommitNext,
  onCancel,
  ariaLabel,
  ariaDescribedBy,
  commitOnBlur,
}: CellEditorProps) {
  const initial = typeof value === "string" ? splitIso(value) : null;
  const [draft, setDraft] = useState(initial?.local ?? "");
  const inputRef = useInitialFocus<HTMLInputElement>();
  const suffix = initial?.suffix ?? "";

  const commit = (submit: CellEditorProps["onCommit"] = onCommit) => {
    if (draft === "") {
      submit(null);
      return;
    }
    // Reattach the value's original zone suffix (none for local date-times).
    submit(`${withSeconds(draft)}${suffix}`, definition.type);
  };

  return (
    <input
      ref={inputRef}
      aria-label={ariaLabel ?? "Edit datetime"}
      aria-describedby={ariaDescribedBy}
      type="datetime-local"
      step={1}
      className={CELL_INPUT_CLASS}
      value={draft}
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
