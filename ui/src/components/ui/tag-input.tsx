import { X } from "lucide-react";
import {
  type Key,
  type KeyboardEvent,
  useCallback,
  useId,
  useRef,
  useState,
} from "react";
import { Button, Tag, TagGroup, TagList } from "react-aria-components";
import { formatApiError } from "#/api/error";
import { cn } from "#/lib/cn";

export type TagInputVariant = "default" | "codex";

export interface TagInputProps {
  label: string;
  values: string[];
  readOnlyValues?: string[];
  suggestions?: string[];
  allowCreate?: boolean;
  onSuggestionQueryChange?: (query: string) => void;
  suggestionsLoading?: boolean;
  suggestionsError?: unknown;
  onRetrySuggestions?: () => void;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  onChange: (values: string[]) => void;
  placeholder?: string;
  className?: string;
  variant?: TagInputVariant;
  valuePrefix?: string;
  maxSuggestions?: number;
  /** Called after the input loses focus (and any draft is committed). */
  onBlur?: () => void;
}

const tagsEqual = (left: string, right: string) =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

export function TagInput({
  label,
  values,
  readOnlyValues = [],
  suggestions,
  allowCreate = true,
  onSuggestionQueryChange,
  suggestionsLoading = false,
  suggestionsError = null,
  onRetrySuggestions,
  ariaLabel,
  ariaDescribedBy,
  onChange,
  placeholder,
  variant = "default",
  valuePrefix = "",
  maxSuggestions = 5,
  className,
  onBlur,
}: TagInputProps) {
  const [inputValue, setInputValue] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const hasSuggestions =
    suggestions !== undefined || onSuggestionQueryChange !== undefined;
  const listId = useId();
  const stripValuePrefix = useCallback(
    (value: string) =>
      valuePrefix && value.startsWith(valuePrefix)
        ? value.slice(valuePrefix.length)
        : value,
    [valuePrefix],
  );
  const query = stripValuePrefix(inputValue.trim());
  const queryLower = query.toLowerCase();
  const matches =
    query && !suggestionsLoading && !suggestionsError
      ? (suggestions ?? [])
          .filter(
            (suggestion) =>
              suggestion.toLowerCase().includes(queryLower) &&
              !values.some((value) => tagsEqual(suggestion, value)) &&
              !readOnlyValues.some((value) => tagsEqual(suggestion, value)),
          )
          .slice(0, maxSuggestions)
      : [];
  const open = !dismissed && matches.length > 0;
  const selected = Math.min(highlight, Math.max(matches.length - 1, 0));
  const inputRef = useRef<HTMLInputElement>(null);

  const resolveCandidate = useCallback(
    (value: string): string | null => {
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (allowCreate) return trimmed;
      return (
        suggestions?.find((suggestion) => tagsEqual(suggestion, trimmed)) ??
        null
      );
    },
    [allowCreate, suggestions],
  );

  const addValue = useCallback(
    (val: string) => {
      const candidate = resolveCandidate(val);
      if (
        candidate &&
        !values.some((value) => tagsEqual(candidate, value)) &&
        !readOnlyValues.some((value) => tagsEqual(candidate, value))
      ) {
        onChange([...values, candidate]);
      }
      setInputValue("");
      setHighlight(0);
      setNavigated(false);
      setDismissed(false);
      onSuggestionQueryChange?.("");
    },
    [
      resolveCandidate,
      values,
      readOnlyValues,
      onChange,
      onSuggestionQueryChange,
    ],
  );

  const handleRemove = useCallback(
    (keys: Set<Key>) => {
      onChange(values.filter((v) => !keys.has(v)));
    },
    [values, onChange],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown" && matches.length > 0) {
        e.preventDefault();
        setDismissed(false);
        setHighlight(Math.min(selected + 1, matches.length - 1));
        setNavigated(true);
      } else if (e.key === "ArrowUp" && open) {
        e.preventDefault();
        setHighlight(Math.max(selected - 1, 0));
        setNavigated(true);
      } else if (e.key === "Tab") {
        if (open) {
          e.preventDefault();
          addValue(matches[selected]);
        } else if (query !== "") {
          // Preserve raw-entry completion when suggestions are unavailable.
          e.preventDefault();
          addValue(query);
        }
      } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        addValue(
          open && (!allowCreate || navigated) ? matches[selected] : query,
        );
      } else if (e.key === ",") {
        e.preventDefault();
        addValue(query);
      } else if (
        e.key === "Backspace" &&
        inputValue === "" &&
        values.length > 0
      ) {
        onChange(values.slice(0, -1));
      } else if (e.key === "Escape" && open) {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(true);
      }
    },
    [
      open,
      selected,
      matches,
      query,
      navigated,
      allowCreate,
      inputValue,
      values,
      addValue,
      onChange,
    ],
  );

  return (
    <div
      className={cn(
        "relative flex flex-wrap items-center gap-1",
        variant === "codex" &&
          "mt-1 border border-rule p-1 focus-within:border-accent",
        className,
      )}
      onClick={() => inputRef.current?.focus()}
    >
      <span className="text-xs text-muted-foreground">{label}:</span>
      {readOnlyValues.length > 0 && (
        <TagGroup aria-label={`Read-only ${label}`} className="contents">
          <TagList
            items={readOnlyValues.map((v) => ({ id: v, name: v }))}
            className="contents"
          >
            {(item) => (
              <Tag
                id={item.id}
                textValue={item.name}
                className={cn(
                  "flex items-center gap-1 border border-border bg-muted px-2 py-0.5 text-xs",
                  variant === "codex" &&
                    "cl-mono inline-flex border-rule bg-paper-2 px-1.5 py-[1px] text-[11px] tracking-[0.04em] text-ink-2",
                )}
              >
                {`${valuePrefix}${item.name}`}
              </Tag>
            )}
          </TagList>
        </TagGroup>
      )}
      {values.length > 0 && (
        <TagGroup
          onRemove={handleRemove}
          aria-label={ariaLabel ?? label}
          aria-describedby={ariaDescribedBy}
          className="contents"
        >
          <TagList
            items={values.map((v) => ({ id: v, name: v }))}
            className="contents"
          >
            {(item) => (
              <Tag
                id={item.id}
                textValue={item.name}
                className={cn(
                  "flex items-center gap-1 border border-border bg-muted px-2 py-0.5 text-xs",
                  variant === "codex" &&
                    "cl-mono inline-flex border-rule bg-paper-2 px-1.5 py-[1px] text-[11px] tracking-[0.04em] text-ink-2",
                )}
              >
                {({ allowsRemoving }) => (
                  <>
                    {`${valuePrefix}${item.name}`}
                    {allowsRemoving && (
                      <Button
                        slot="remove"
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    )}
                  </>
                )}
              </Tag>
            )}
          </TagList>
        </TagGroup>
      )}
      <input
        ref={inputRef}
        type="text"
        aria-label={ariaLabel ?? `Add ${label.toLowerCase()}`}
        aria-describedby={ariaDescribedBy}
        value={inputValue}
        role={hasSuggestions ? "combobox" : undefined}
        aria-expanded={hasSuggestions ? open : undefined}
        aria-controls={hasSuggestions && open ? listId : undefined}
        aria-activedescendant={
          hasSuggestions && open ? `${listId}-${selected}` : undefined
        }
        aria-autocomplete={hasSuggestions ? "list" : undefined}
        onChange={(e) => {
          const nextValue = e.target.value;
          setInputValue(nextValue);
          setHighlight(0);
          setNavigated(false);
          setDismissed(false);
          onSuggestionQueryChange?.(stripValuePrefix(nextValue.trim()));
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (inputValue.trim()) addValue(query);
          onBlur?.();
        }}
        placeholder={
          values.length === 0 && readOnlyValues.length === 0
            ? placeholder
            : undefined
        }
        className={cn(
          "min-w-[80px] flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground",
          variant === "codex" &&
            "cl-mono min-w-[8ch] border-none p-[2px] text-[12px] text-ink placeholder:text-ink-mute",
        )}
      />
      {query && suggestionsLoading ? (
        <span role="status" className="text-xs text-muted-foreground">
          Loading tag suggestions…
        </span>
      ) : null}
      {query && suggestionsError ? (
        <span className="flex items-center gap-2 text-xs text-destructive">
          <span role="alert">
            {formatApiError(suggestionsError, "Tag suggestions unavailable")}
          </span>
          {onRetrySuggestions ? (
            <button
              type="button"
              aria-label="Retry tag suggestions"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                onRetrySuggestions();
                inputRef.current?.focus();
              }}
              className="underline"
            >
              Retry
            </button>
          ) : null}
        </span>
      ) : null}
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Tag suggestions"
          className={cn(
            "absolute left-0 right-0 top-full z-20 m-0 max-h-[200px] list-none overflow-auto border border-border bg-background p-0.5",
            variant === "codex" && "cl-mono border-rule bg-paper",
          )}
        >
          {matches.map((suggestion, index) => (
            <li
              key={suggestion}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === selected}
              onMouseDown={(event) => {
                event.preventDefault();
                addValue(suggestion);
              }}
              className={cn(
                "cursor-pointer px-2 py-1 text-xs",
                variant === "codex" &&
                  "text-[11px] tracking-[0.04em] text-ink-2",
                index === selected &&
                  (variant === "codex"
                    ? "bg-highlight font-bold text-ink"
                    : "bg-muted font-bold"),
              )}
            >
              {`${valuePrefix}${suggestion}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
