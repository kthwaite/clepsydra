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

/**
 * Relation cell: a text input with canonical-name suggestions from the
 * search index (the ProjectCombo pattern, datalist-flavored). Commits the
 * value in wikilink syntax; multi-valued relations edit their first target.
 */
export function RelationCell({ value, onCommit, onCancel }: CellEditorProps) {
  const first = Array.isArray(value) ? (value[0] ?? null) : value;
  const [draft, setDraft] = useState(unwrap(first));
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const listId = useId();

  useEffect(() => {
    let cancelled = false;
    const q = draft.trim();
    if (q === "") {
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
        list={listId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={onCancel}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const target = draft.trim();
            onCommit(target === "" ? null : [`[[${target}]]`]);
          }
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
