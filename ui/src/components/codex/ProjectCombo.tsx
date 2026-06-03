import { useRef, useState } from "react";
import {
  Button,
  ComboBox,
  Input,
  ListBox,
  ListBoxItem,
  Popover,
} from "react-aria-components";
import { cn } from "#/lib/cn";

export interface ProjectComboProps {
  value: string | null;
  options: string[];
  onAssign: (slug: string) => void;
  onClear: () => void;
}

export function ProjectCombo({
  value,
  options,
  onAssign,
  onClear,
}: ProjectComboProps) {
  // Track the live input so committed custom values (which react-aria reports
  // via onInputChange rather than onSelectionChange when they match no item —
  // see ComboBox docs §"controlled value") can be flushed to onAssign on
  // Enter/blur.
  const [draft, setDraft] = useState(value ?? "");

  // A listbox pick fires onSelectionChange (→ onAssign) and then a blur, whose
  // commit() would call onAssign a second time (the slug !== value guard still
  // passes because `value` hasn't propagated yet) — a redundant mutate racing
  // the in-flight rename. This flag suppresses the immediate post-select blur.
  const justSelectedRef = useRef(false);

  const commit = () => {
    if (justSelectedRef.current) {
      justSelectedRef.current = false;
      return;
    }
    const slug = draft.trim();
    if (slug && slug !== value) {
      justSelectedRef.current = true;
      onAssign(slug);
    }
  };

  return (
    <div className="flex items-center gap-1">
      <ComboBox
        aria-label="Project"
        allowsCustomValue
        defaultInputValue={value ?? ""}
        onInputChange={setDraft}
        onSelectionChange={(k) => {
          if (k) {
            justSelectedRef.current = true;
            onAssign(String(k));
          }
        }}
        className="min-w-0 flex-1"
      >
        <Input
          placeholder="∅ none"
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
          onBlur={commit}
          className={cn(
            "cl-mono w-full border border-rule bg-transparent px-1.5 py-[2px] text-[11px] tracking-[0.04em] text-ink-2 outline-none transition-colors",
            "placeholder:text-ink-mute",
            "data-[hovered]:border-accent",
            "data-[focused]:border-accent data-[focused]:text-ink",
          )}
        />
        <Popover className="border border-rule bg-paper outline-none">
          <ListBox className="cl-mono max-h-[280px] overflow-auto p-0.5 outline-none">
            {options.map((p) => (
              <ListBoxItem
                key={p}
                id={p}
                textValue={p}
                className={cn(
                  "cursor-pointer px-2 py-1 text-[11px] tracking-[0.04em] text-ink-2 outline-none",
                  "data-[hovered]:bg-highlight data-[hovered]:text-ink",
                  "data-[focused]:bg-highlight data-[focused]:text-ink",
                  "data-[selected]:font-bold data-[selected]:text-ink",
                )}
              >
                {p}
              </ListBoxItem>
            ))}
          </ListBox>
        </Popover>
      </ComboBox>
      {value !== null && (
        <Button
          aria-label="Clear project"
          onPress={onClear}
          className={cn(
            "cl-mono flex-shrink-0 cursor-pointer px-1 text-[11px] text-ink-mute outline-none transition-colors",
            "data-[hovered]:text-hot",
            "data-[focus-visible]:outline data-[focus-visible]:outline-1 data-[focus-visible]:outline-accent",
          )}
        >
          ×
        </Button>
      )}
    </div>
  );
}
