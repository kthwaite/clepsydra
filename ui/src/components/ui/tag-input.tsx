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
import { cn } from "#/lib/cn";

const MAX_SUGGESTIONS = 5;

export interface TagInputProps {
  label: string;
  values: string[];
  readOnlyValues?: string[];
  suggestions?: string[];
  ariaLabel?: string;
  ariaDescribedBy?: string;
  onChange: (values: string[]) => void;
  placeholder?: string;
  className?: string;
  /** Called after the input loses focus (and any draft is committed). */
  onBlur?: () => void;
}

export function TagInput({
  label,
  values,
  readOnlyValues = [],
  suggestions,
  ariaLabel,
  ariaDescribedBy,
  onChange,
  placeholder,
  className,
  onBlur,
}: TagInputProps) {
  const [inputValue, setInputValue] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const hasSuggestions = suggestions !== undefined;
  const listId = useId();
  const query = inputValue.trim();
  const queryLower = query.toLowerCase();
  const matches = query
    ? (suggestions ?? [])
        .filter(
          (suggestion) =>
            suggestion.toLowerCase().includes(queryLower) &&
            !values.includes(suggestion) &&
            !readOnlyValues.includes(suggestion),
        )
        .slice(0, MAX_SUGGESTIONS)
    : [];
  const open = !dismissed && matches.length > 0;
  const selected = Math.min(highlight, Math.max(matches.length - 1, 0));
  const inputRef = useRef<HTMLInputElement>(null);

  const addValue = useCallback(
    (val: string) => {
      const trimmed = val.trim();
      if (
        trimmed &&
        !values.includes(trimmed) &&
        !readOnlyValues.includes(trimmed)
      ) {
        onChange([...values, trimmed]);
      }
      setInputValue("");
      setHighlight(0);
      setNavigated(false);
      setDismissed(false);
    },
    [values, readOnlyValues, onChange],
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
        addValue(navigated && open ? matches[selected] : query);
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
      inputValue,
      values,
      addValue,
      onChange,
    ],
  );

  return (
    <div
      className={cn("relative flex flex-wrap items-center gap-1", className)}
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
                className="flex items-center gap-1 border border-border bg-muted px-2 py-0.5 text-xs"
              >
                {item.name}
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
                className="flex items-center gap-1 border border-border bg-muted px-2 py-0.5 text-xs"
              >
                {({ allowsRemoving }) => (
                  <>
                    {item.name}
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
          setInputValue(e.target.value);
          setHighlight(0);
          setNavigated(false);
          setDismissed(false);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (inputValue.trim()) addValue(inputValue);
          onBlur?.();
        }}
        placeholder={
          values.length === 0 && readOnlyValues.length === 0
            ? placeholder
            : undefined
        }
        className="min-w-[80px] flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Tag suggestions"
          className="absolute left-0 right-0 top-full z-10 m-0 max-h-[200px] list-none overflow-auto border border-border bg-background p-0.5"
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
                index === selected && "bg-muted font-bold",
              )}
            >
              {suggestion}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
