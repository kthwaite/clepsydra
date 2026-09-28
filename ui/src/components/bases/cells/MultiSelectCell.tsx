import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { TagInput } from "#/components/ui/tag-input";
import { type CellEditorProps, tabCommit } from "./types";

function currentValues(value: CellEditorProps["value"]): string[] {
  if (typeof value === "string") return value === "" ? [] : [value];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return [];
}

/** TagInput's own duplicate rule: trimmed, case-insensitive. */
const sameValue = (left: string, right: string) =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

function withValue(values: string[], candidate: string): string[] {
  const trimmed = candidate.trim();
  if (trimmed === "" || values.some((value) => sameValue(value, trimmed))) {
    return values;
  }
  return [...values, trimmed];
}

/**
 * Multi-select editor: a tag input over an open vocabulary. Suggestions are
 * the declared options plus any caller-supplied values (the column's). A
 * commit always carries the complete value set, never a single value, and
 * includes text typed but not yet added.
 *
 * Enter adds the typed value (or the highlighted suggestion); Enter on an
 * empty field commits. Escape closes open suggestions, then cancels. Tab and
 * Shift+Tab commit and move, except in drafts (`commitOnBlur`). Blur leaving
 * the editor commits in drafts and cancels inline.
 */
export function MultiSelectCell({
  value,
  definition,
  suggestions,
  onCommit,
  onCommitNext,
  onCommitPrevious,
  onCancel,
  ariaLabel,
  ariaDescribedBy,
  commitOnBlur,
}: CellEditorProps) {
  const [selected, setSelected] = useState<string[]>(() =>
    currentValues(value),
  );
  const rootRef = useRef<HTMLFieldSetElement>(null);
  const name = ariaLabel ?? "Edit multi-select";

  const choices = useMemo(
    () =>
      [...(definition.options ?? []), ...(suggestions ?? [])].reduce<string[]>(
        withValue,
        [],
      ),
    [definition.options, suggestions],
  );

  const input = () => rootRef.current?.querySelector("input") ?? null;

  useLayoutEffect(() => {
    rootRef.current?.querySelector("input")?.focus();
  }, []);

  const commit = (submit: CellEditorProps["onCommit"] = onCommit) => {
    // `selected` may lag a same-event add; the field's text is still there.
    const next = withValue(selected, input()?.value ?? "");
    submit(next.length === 0 ? null : next);
  };

  return (
    <fieldset
      ref={rootRef}
      className="m-0 min-w-0 border-0 p-0"
      onKeyDownCapture={(event) => {
        const tabSubmit = tabCommit(event, {
          commitOnBlur,
          onCommitNext,
          onCommitPrevious,
        });
        if (tabSubmit) {
          event.preventDefault();
          event.stopPropagation();
          commit(tabSubmit);
        }
      }}
      // Bubble phase: TagInput has already handled the key. It stops
      // Escape while suggestions are open, so that Escape never gets here.
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          !event.metaKey &&
          !event.ctrlKey &&
          event.target === input() &&
          (input()?.value.trim() ?? "") === ""
        ) {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        if (commitOnBlur) {
          commit();
        } else {
          onCancel();
        }
      }}
    >
      <TagInput
        label="Values"
        hideLabel
        ariaLabel={name}
        valuesLabel={`${name} values`}
        ariaDescribedBy={ariaDescribedBy}
        values={selected}
        suggestions={choices}
        maxSuggestions={8}
        floatingSuggestions
        placeholder="Add value"
        onChange={setSelected}
        className="min-w-[10rem] gap-1"
      />
    </fieldset>
  );
}
