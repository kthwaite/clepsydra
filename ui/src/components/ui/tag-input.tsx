import { X } from "lucide-react";
import {
  type Key,
  type KeyboardEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import { Button, Tag, TagGroup, TagList } from "react-aria-components";
import { cn } from "#/lib/cn";

export interface TagInputProps {
  label: string;
  values: string[];
  readOnlyValues?: string[];
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
  onChange,
  placeholder,
  className,
  onBlur,
}: TagInputProps) {
  const [inputValue, setInputValue] = useState("");
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
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        addValue(inputValue);
      } else if (e.key === "Tab" && inputValue.trim() !== "") {
        // Commit the in-progress tag and keep the cursor here instead of
        // letting Tab move focus to the next field. Empty input falls
        // through so Tab still navigates normally.
        e.preventDefault();
        addValue(inputValue);
      } else if (
        e.key === "Backspace" &&
        inputValue === "" &&
        values.length > 0
      ) {
        onChange(values.slice(0, -1));
      }
    },
    [inputValue, values, addValue, onChange],
  );

  return (
    <div
      className={cn("flex flex-wrap items-center gap-1", className)}
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
          aria-label={label}
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
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (inputValue.trim()) addValue(inputValue);
          onBlur?.();
        }}
        aria-label={`Add ${label.toLowerCase()}`}
        placeholder={
          values.length === 0 && readOnlyValues.length === 0
            ? placeholder
            : undefined
        }
        className="min-w-[80px] flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
