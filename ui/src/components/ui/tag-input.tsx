import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
} from "@floating-ui/react";
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
import { FOCUS_RING } from "#/lib/focusRing";

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
  /** Keep the label for assistive tech only (e.g. inside a table cell). */
  hideLabel?: boolean;
  /** Accessible name of the chip group; defaults to `ariaLabel ?? label`. */
  valuesLabel?: string;
  /**
   * Position the suggestion list with fixed positioning so a scrolling or
   * clipping ancestor (a table cell) cannot cut it off. It stays a DOM
   * descendant of the field, so focus logic still sees it as inside.
   */
  floatingSuggestions?: boolean;
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
  hideLabel = false,
  valuesLabel,
  floatingSuggestions = false,
}: TagInputProps) {
  const [inputValue, setInputValue] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const hasSuggestions =
    suggestions !== undefined || onSuggestionQueryChange !== undefined;
  const listId = useId();
  const inputId = useId();
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
  // Until the author arrows through the list, an exact match is highlighted
  // so Tab and Enter never swap a typed tag for a longer one.
  const exactIndex = matches.findIndex((match) => tagsEqual(match, query));
  const selected =
    !navigated && exactIndex >= 0
      ? exactIndex
      : Math.min(highlight, Math.max(matches.length - 1, 0));
  const inputRef = useRef<HTMLInputElement>(null);
  const floating = useFloating({
    open: floatingSuggestions && open,
    placement: "bottom-start",
    strategy: "fixed",
    middleware: [offset(4), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const suggestionInputProps = hasSuggestions
    ? {
        role: "combobox" as const,
        "aria-expanded": open,
        "aria-controls": open ? listId : undefined,
        "aria-activedescendant": open
          ? `${listId}-${encodeURIComponent(matches[selected])}`
          : undefined,
        "aria-autocomplete": "list" as const,
      }
    : {};

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
        // Like Tab: complete the highlighted suggestion. Escape closes the
        // list first when the raw draft should become a new tag.
        addValue(open ? matches[selected] : query);
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
      inputValue,
      values,
      addValue,
      onChange,
    ],
  );

  return (
    <fieldset
      ref={floatingSuggestions ? floating.refs.setReference : undefined}
      aria-label={label}
      className={cn(
        "relative m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0",
        variant === "codex" &&
          "mt-1 rounded-[14px] bg-sink px-2 py-1.5 has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-accent",
        className,
      )}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          inputRef.current?.focus();
        }
      }}
    >
      <label
        htmlFor={inputId}
        className={cn("text-[12.5px] text-mute", hideLabel && "sr-only")}
      >
        {label}:
      </label>
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
                  "flex h-7 items-center gap-1 rounded-full px-2.5 text-[13px] text-ink-2",
                  variant === "codex" ? "bg-raise" : "bg-sink",
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
          aria-label={valuesLabel ?? ariaLabel ?? label}
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
                  "flex h-7 items-center gap-1 rounded-full px-2.5 text-[13px] text-ink-2",
                  variant === "codex" ? "bg-raise" : "bg-sink",
                )}
              >
                {({ allowsRemoving }) => (
                  <>
                    {`${valuePrefix}${item.name}`}
                    {allowsRemoving && (
                      <Button
                        slot="remove"
                        className={cn(
                          "rounded-full p-0.5 text-mute hover:text-ink",
                          FOCUS_RING,
                        )}
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
        id={inputId}
        {...suggestionInputProps}
        aria-label={ariaLabel ?? `Add ${label.toLowerCase()}`}
        aria-describedby={ariaDescribedBy}
        value={inputValue}
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
          "min-w-[80px] flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-mute",
          variant === "codex" && "min-w-[8ch] p-[2px]",
        )}
      />
      {query && suggestionsLoading ? (
        <span role="status" className="text-[12.5px] text-mute">
          Loading tag suggestions…
        </span>
      ) : null}
      {query && suggestionsError ? (
        <span className="flex items-center gap-2 text-[12.5px] text-hot">
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
        <div
          ref={floatingSuggestions ? floating.refs.setFloating : undefined}
          id={listId}
          role="listbox"
          aria-label="Tag suggestions"
          style={
            floatingSuggestions
              ? {
                  ...floating.floatingStyles,
                  // Hidden, not removed, until measured: no flash at the origin.
                  opacity: floating.isPositioned ? undefined : 0,
                }
              : undefined
          }
          className={cn(
            "z-20 m-0 max-h-[200px] list-none overflow-auto rounded-xl bg-raise p-1.5 shadow-lg",
            floatingSuggestions
              ? "z-50 min-w-48 max-w-80"
              : "absolute left-0 right-0 top-full mt-1",
          )}
        >
          {matches.map((suggestion, index) => (
            <div
              key={suggestion}
              id={`${listId}-${encodeURIComponent(suggestion)}`}
              role="option"
              aria-selected={index === selected}
              tabIndex={-1}
              onMouseDown={(event) => {
                event.preventDefault();
                addValue(suggestion);
              }}
              className={cn(
                "cursor-pointer rounded-lg px-3 py-1.5 text-[13.5px] text-ink",
                index === selected && "bg-accent-tint font-medium",
              )}
            >
              {`${valuePrefix}${suggestion}`}
            </div>
          ))}
        </div>
      )}
    </fieldset>
  );
}
