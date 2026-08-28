import { useEffect, useRef, useState } from "react";
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
  /** Slugs PROJECT pages declare — the only values that can commit. */
  options: string[];
  ariaLabel?: string;
  ariaDescribedBy?: string;
  menuTrigger?: "focus" | "input" | "manual";
  onAssign: (slug: string) => void;
  onClear: () => void;
}

const NO_SUCH_PROJECT = "no such project";

/** Strict project picker: only a listed slug commits. A listbox pick, or
 *  Enter/blur on a draft spelling a listed slug (case-insensitive, trimmed),
 *  assigns it; Enter on anything else keeps the draft and says so; blur on
 *  anything else reverts to the current value. Creating a project is a
 *  separate step (a PROJECT page), never a side effect of this field. */
export function ProjectCombo({
  value,
  options,
  ariaLabel,
  ariaDescribedBy,
  menuTrigger,
  onAssign,
  onClear,
}: ProjectComboProps) {
  // `selected` mirrors `value` but leads it: a pick lands here at once so the
  // listbox closes and the follow-up blur sees nothing new to assign, even
  // when the caller leaves `value` unchanged (bulk apply).
  const [selected, setSelected] = useState(value);
  const [draft, setDraft] = useState(value ?? "");
  const [hint, setHint] = useState<string | null>(null);
  // Enter on a bare draft remounts the ComboBox (as PersonCombo does after a
  // pick). With selection and input both controlled, react-aria's own Enter
  // commit expects the input to become the selected item's text; a draft kept
  // as typed, or normalised to the slug's spelling, has its next render reopen
  // the listbox. A fresh mount starts closed and in step; focus is put back.
  const [epoch, setEpoch] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSelected(value);
    setDraft(value ?? "");
    setHint(null);
  }, [value]);

  useEffect(() => {
    if (epoch > 0) inputRef.current?.focus();
  }, [epoch]);

  const findListed = (text: string): string | undefined => {
    const needle = text.trim().toLowerCase();
    if (!needle) return undefined;
    return options.find((slug) => slug.toLowerCase() === needle);
  };

  const pick = (slug: string) => {
    setSelected(slug);
    setDraft(slug);
    setHint(null);
    onAssign(slug);
  };

  // Enter on a bare draft (no option focused — those belong to react-aria).
  const commitDraft = () => {
    const slug = findListed(draft);
    if (slug === undefined) {
      setHint(draft.trim() ? NO_SUCH_PROJECT : null);
    } else if (slug !== selected) {
      pick(slug);
    } else {
      setDraft(slug);
      setHint(null);
    }
    setEpoch((n) => n + 1);
  };

  const settleDraft = () => {
    const slug = findListed(draft);
    if (slug === undefined) {
      setDraft(selected ?? "");
    } else if (slug !== selected) {
      pick(slug);
    } else {
      setDraft(slug);
    }
    setHint(null);
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1">
        <ComboBox
          key={epoch}
          aria-label={ariaLabel ?? "Project"}
          aria-describedby={ariaDescribedBy}
          menuTrigger={menuTrigger}
          selectedKey={selected}
          inputValue={draft}
          onInputChange={(text) => {
            setDraft(text);
            setHint(null);
          }}
          onSelectionChange={(key) => {
            // With both selection and input controlled, react-aria echoes the
            // current key on Enter/blur; only a new key is a pick.
            if (key != null && key !== selected) pick(String(key));
          }}
          className="min-w-0 flex-1"
        >
          <Input
            ref={inputRef}
            placeholder="∅ none"
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.nativeEvent.isComposing &&
                !event.currentTarget.getAttribute("aria-activedescendant")
              ) {
                commitDraft();
              }
            }}
            onBlur={settleDraft}
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
            aria-label={ariaLabel ? `Clear ${ariaLabel}` : "Clear project"}
            aria-describedby={ariaDescribedBy}
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
      {/* Always mounted so assistive tech announces the hint when it lands. */}
      <div
        role="status"
        className={cn("cl-mono text-[10px] text-hot", hint && "mt-0.5")}
      >
        {hint && `⁂ ${hint}`}
      </div>
    </div>
  );
}
