import { useEffect, useId, useState } from "react";
import {
  CELL_INPUT_CLASS,
  type CellEditorProps,
  type CellValue,
} from "./types";

/** Strip `[[Target|display]]` down to `Target` for editing. */
function unwrap(value: CellValue): string {
  if (typeof value !== "string") return "";
  const inner = value.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
  return inner.split("|")[0] ?? inner;
}

function targetsOf(value: CellValue): string[] {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  return raw.map(unwrap).filter((t) => t !== "");
}

/**
 * Relation cell: edits the FULL target list as comma-separated names (so a
 * multi-target relation never silently collapses to its first element),
 * committing each target back in wikilink syntax. Canonical-name
 * suggestions from the search index apply while a single target is typed.
 */
export function RelationCell({
  value,
  onCommit,
  onCommitNext,
  onCancel,
}: CellEditorProps) {
  const [draft, setDraft] = useState(targetsOf(value).join(", "));
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const listId = useId();
  const singleTarget = !draft.includes(",");
  const commit = (submit: CellEditorProps["onCommit"] = onCommit) => {
    const targets = draft
      .split(",")
      .map((target) => target.trim())
      .filter((target) => target !== "");
    submit(targets.length === 0 ? null : targets.map((target) => `[[${target}]]`));
  };

  useEffect(() => {
    let cancelled = false;
    const q = draft.trim();
    if (q === "" || q.includes(",")) {
      setSuggestions([]);
      return;
    }
    void fetch(`/api/vault/index/search?q=${encodeURIComponent(q)}&limit=8`)
      .then((res) => (res.ok ? res.json() : []))
      .then((rows: Array<{ title?: string | null; path: string }>) => {
        if (cancelled) return;
        setSuggestions(
          rows.map(
            (r) =>
              r.title ?? r.path.replace(/\.md$/, "").split("/").pop() ?? "",
          ),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [draft]);

  return (
    <>
      <input
        autoFocus
        aria-label="Edit relation"
        className={CELL_INPUT_CLASS}
        list={singleTarget ? listId : undefined}
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
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </>
  );
}
