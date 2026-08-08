import { type KeyboardEvent, useId, useRef, useState } from "react";
import { cn } from "#/lib/cn";

export interface TagsInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  /** Known tags offered as completions (e.g. from the vault tag index). */
  suggestions: string[];
  placeholder?: string;
}

const MAX_SUGGESTIONS = 8;

/** Inline chiclet tag editor with autosuggest. Typing filters `suggestions`;
 * Tab completes the highlighted match, Enter commits the draft (or the
 * highlighted match after arrow navigation), comma commits, and Backspace
 * on an empty draft removes the last chip. Escape closes the suggestion list
 * first and only bubbles (e.g. to a modal dismiss handler) when no list is
 * open. */
export function TagsInput({
  value,
  onChange,
  suggestions,
  placeholder,
}: TagsInputProps) {
  const [draft, setDraft] = useState("");
  const [highlight, setHighlight] = useState(0);
  // Arrow navigation opts Enter into the highlighted suggestion; plain typing
  // keeps Enter committing the raw draft.
  const [navigated, setNavigated] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const query = draft.trim().replace(/^#/, "");
  const ql = query.toLowerCase();
  const matches = query
    ? suggestions
        .filter((s) => s.toLowerCase().includes(ql) && !value.includes(s))
        .slice(0, MAX_SUGGESTIONS)
    : [];
  const open = !dismissed && matches.length > 0;
  const sel = Math.min(highlight, Math.max(matches.length - 1, 0));

  const setDraftAndReset = (next: string) => {
    setDraft(next);
    setHighlight(0);
    setNavigated(false);
    setDismissed(false);
  };

  const commit = (raw: string) => {
    const tag = raw.trim().replace(/^#/, "");
    if (tag && !value.includes(tag)) onChange([...value, tag]);
    setDraftAndReset("");
  };

  const remove = (tag: string) => {
    onChange(value.filter((t) => t !== tag));
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && matches.length) {
      e.preventDefault();
      setDismissed(false);
      setNavigated(true);
      setHighlight((h) => Math.min(h + 1, matches.length - 1));
    } else if (e.key === "ArrowUp" && matches.length) {
      e.preventDefault();
      setNavigated(true);
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Tab" && open) {
      e.preventDefault();
      commit(matches[sel]);
    } else if (e.key === "Enter" && query) {
      e.preventDefault();
      commit(open && navigated ? matches[sel] : query);
    } else if (e.key === ",") {
      e.preventDefault();
      if (query) commit(query);
    } else if (e.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    } else if (e.key === "Escape" && open) {
      // Swallow the first Escape to close the list; a second one bubbles to
      // the surrounding modal.
      e.preventDefault();
      e.stopPropagation();
      setDismissed(true);
    }
  };

  return (
    <div className="relative">
      <div
        className={cn(
          "mt-1 flex flex-wrap items-center gap-1 border border-rule p-1",
          "focus-within:border-accent",
        )}
      >
        {value.map((tag) => (
          <span
            key={tag}
            className="cl-mono inline-flex items-center gap-1 border border-rule bg-paper-2 px-1.5 py-[1px] text-[11px] tracking-[0.04em] text-ink-2"
          >
            #{tag}
            <button
              type="button"
              aria-label={`remove ${tag}`}
              onClick={() => remove(tag)}
              className="cursor-pointer text-ink-mute transition-colors hover:text-hot"
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          role="combobox"
          aria-label="Tags"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${sel}` : undefined}
          aria-autocomplete="list"
          value={draft}
          onChange={(e) => setDraftAndReset(e.target.value)}
          onBlur={() => {
            if (query) commit(query);
          }}
          onKeyDown={onKeyDown}
          placeholder={value.length ? undefined : placeholder}
          className="cl-mono min-w-[8ch] flex-1 border-none bg-transparent p-[2px] text-[12px] text-ink outline-none placeholder:text-ink-mute"
        />
      </div>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Tag suggestions"
          className="cl-mono absolute left-0 right-0 top-full z-10 m-0 max-h-[200px] list-none overflow-auto border border-rule bg-paper p-0.5"
        >
          {matches.map((s, i) => (
            <li
              key={s}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === sel}
              // mousedown (not click) so the input keeps focus and blur-commit
              // doesn't fire first with the raw draft
              onMouseDown={(e) => {
                e.preventDefault();
                commit(s);
              }}
              className={cn(
                "cursor-pointer px-2 py-1 text-[11px] tracking-[0.04em] text-ink-2",
                i === sel && "bg-highlight font-bold text-ink",
              )}
            >
              #{s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
