import { type KeyboardEvent, useCallback, useState } from "react";

interface PageEditorHeaderProps {
  path: string;
  title: string;
  onTitleChange: (title: string) => void;
  tags: string[];
  onTagsChange: (tags: string[]) => void;
  aliases: string[];
  onAliasesChange: (aliases: string[]) => void;
}

export function PageEditorHeader({
  path,
  title,
  onTitleChange,
  tags,
  onTagsChange,
  aliases,
  onAliasesChange,
}: PageEditorHeaderProps) {
  return (
    <div className="border-b border-border pb-4">
      {/* Title */}
      <input
        type="text"
        value={title}
        onChange={(e) => onTitleChange(e.target.value)}
        placeholder="Untitled"
        className="w-full bg-transparent font-heading text-2xl font-bold outline-none placeholder:text-muted-foreground"
      />

      {/* Path (read-only) */}
      <p className="mt-1 text-sm text-muted-foreground">{path}</p>

      {/* Tags */}
      <ChipInput
        label="Tags"
        values={tags}
        onChange={onTagsChange}
        placeholder="Add tag..."
      />

      {/* Aliases */}
      {(aliases.length > 0 || tags.length > 0) && (
        <ChipInput
          label="Aliases"
          values={aliases}
          onChange={onAliasesChange}
          placeholder="Add alias..."
        />
      )}
    </div>
  );
}

// --- ChipInput sub-component ---

interface ChipInputProps {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
}

function ChipInput({ label, values, onChange, placeholder }: ChipInputProps) {
  const [inputValue, setInputValue] = useState("");

  const addValue = useCallback(
    (val: string) => {
      const trimmed = val.trim();
      if (trimmed && !values.includes(trimmed)) {
        onChange([...values, trimmed]);
      }
      setInputValue("");
    },
    [values, onChange],
  );

  const removeValue = useCallback(
    (index: number) => {
      onChange(values.filter((_, i) => i !== index));
    },
    [values, onChange],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        addValue(inputValue);
      } else if (
        e.key === "Backspace" &&
        inputValue === "" &&
        values.length > 0
      ) {
        removeValue(values.length - 1);
      }
    },
    [inputValue, values, addValue, removeValue],
  );

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      <span className="text-xs text-muted-foreground">{label}:</span>
      {values.map((value, index) => (
        <span
          key={value}
          className="flex items-center gap-1 border border-border bg-muted px-2 py-0.5 text-xs"
        >
          {value}
          <button
            type="button"
            onClick={() => removeValue(index)}
            className="text-muted-foreground hover:text-foreground"
          >
            &times;
          </button>
        </span>
      ))}
      <input
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (inputValue.trim()) addValue(inputValue);
        }}
        placeholder={values.length === 0 ? placeholder : ""}
        className="min-w-[80px] flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
