import { useEffect, useId, useRef, useState } from "react";
import {
  Button,
  ComboBox,
  ComboBoxStateContext,
  Input,
  ListBox,
  ListBoxItem,
  Popover,
  useFilter,
} from "react-aria-components";
import { cn } from "#/lib/cn";
import { FOCUS_RING } from "#/lib/focusRing";
import {
  ASSIGNABLE_KINDS,
  type Kind,
  kindDisplayLabel,
  sortKindsByLabel,
} from "#/lib/kind";

const OPTIONS = sortKindsByLabel(ASSIGNABLE_KINDS);
const OPTION_KEYS = new Set<string>(OPTIONS);

export interface KindSelectProps {
  /** null renders an empty input (bulk-action mode): picking fires onAssign
   * and the input clears instead of holding the choice. */
  value: Kind | null;
  inferred: boolean;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  immutableReason?: string;
  isDisabled?: boolean;
  placeholder?: string;
  onAssign: (kind: Kind) => void;
}

export function KindSelect({
  value,
  inferred,
  ariaLabel,
  ariaDescribedBy,
  immutableReason,
  isDisabled,
  placeholder,
  onAssign,
}: KindSelectProps) {
  const immutableDescriptionId = useId();
  const describedBy =
    [
      ariaDescribedBy,
      immutableReason !== undefined ? immutableDescriptionId : undefined,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  // The input is a filter draft, not the source of truth; the closed kind set
  // means any text that isn't a committed pick reverts to `value` on blur.
  // Trigger and options both read in sentence case ("Note"); the filter
  // ignores case.
  const [draft, setDraft] = useState(
    value !== null ? kindDisplayLabel(value) : "",
  );
  const [selected, setSelected] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlur = useRef(false);
  const pickedRef = useRef(value);
  const { contains } = useFilter({ sensitivity: "base" });

  useEffect(() => {
    pickedRef.current = value;
    setSelected(value);
    setDraft(value !== null ? kindDisplayLabel(value) : "");
  }, [value]);

  const pick = (next: Kind) => {
    if (next === pickedRef.current && next !== value) return;
    setDraft(value === null ? "" : kindDisplayLabel(next));
    if (next === value) return;
    pickedRef.current = next;
    setSelected(next);
    onAssign(next);
  };

  const commitDraft = (keepFocus: boolean) => {
    const matches = draft.trim()
      ? OPTIONS.filter((option) =>
          contains(kindDisplayLabel(option), draft.trim()),
        )
      : [];
    if (matches.length === 1) {
      pick(matches[0]);
      if (!keepFocus) skipBlur.current = true;
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <ComboBox
        aria-label={ariaLabel ?? "Kind"}
        aria-describedby={describedBy}
        isDisabled={isDisabled || immutableReason !== undefined}
        menuTrigger="focus"
        // QUOTE is renderable but not assignable: it shows in the draft while
        // matching no option key.
        selectedKey={
          selected !== null && OPTION_KEYS.has(selected) ? selected : null
        }
        inputValue={draft}
        onInputChange={setDraft}
        onSelectionChange={(key) => {
          // Closing a controlled input can echo the pre-commit key.
          if (key === value && pickedRef.current !== value) return;
          if (key && OPTION_KEYS.has(String(key))) pick(key as Kind);
        }}
        onOpenChange={(isOpen) => {
          if (isOpen) {
            // A new interaction can retry a refused assignment or repeat a
            // bulk action. Deduplication lasts only for the previous pick.
            pickedRef.current = value;
            if (value === null) setSelected(null);
          }
        }}
        className="relative min-w-0 flex-1"
      >
        <ComboBoxStateContext.Consumer>
          {(state) => (
            <Input
              ref={inputRef}
              placeholder={placeholder}
              onKeyDownCapture={(event) => {
                if (
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229
                ) {
                  event.stopPropagation();
                  return;
                }
                if (event.key === "Tab") {
                  event.stopPropagation();
                  commitDraft(false);
                } else if (
                  event.key === "Enter" &&
                  !event.currentTarget.getAttribute("aria-activedescendant")
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  commitDraft(true);
                  state?.close();
                }
              }}
              onBlur={() => {
                setSelected(value);
                if (skipBlur.current) {
                  skipBlur.current = false;
                  return;
                }
                setDraft(value !== null ? kindDisplayLabel(value) : "");
              }}
              className={cn(
                "h-8 w-full rounded-lg bg-sink pr-9 pl-2.5 text-[13.5px] outline-none transition-colors",
                "placeholder:text-mute",
                "data-[focused]:bg-raise data-[focused]:text-ink data-[focused]:ring-2 data-[focused]:ring-accent",
                "data-[disabled]:cursor-not-allowed data-[disabled]:bg-transparent data-[disabled]:px-0 data-[disabled]:text-mute",
                inferred ? "text-mute" : "text-ink",
              )}
            />
          )}
        </ComboBoxStateContext.Consumer>
        {draft && !isDisabled && immutableReason === undefined && (
          <Button
            slot={null}
            excludeFromTabOrder
            aria-label={ariaLabel ? `Clear ${ariaLabel}` : "Clear kind"}
            onPress={() => {
              setDraft("");
              inputRef.current?.focus();
            }}
            className={cn(
              "absolute right-0.5 top-0.5 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-[15px] text-mute transition-colors",
              "data-[hovered]:bg-sink data-[hovered]:text-ink",
              FOCUS_RING,
            )}
          >
            ×
          </Button>
        )}
        <Popover className="w-(--trigger-width) rounded-xl bg-raise p-1 shadow-lg outline-none">
          <ListBox className="max-h-[280px] overflow-auto outline-none">
            {OPTIONS.map((k) => (
              <ListBoxItem
                key={k}
                id={k}
                textValue={kindDisplayLabel(k)}
                className={cn(
                  "cursor-pointer rounded-lg px-2.5 py-1.5 text-[13.5px] text-ink-2 outline-none",
                  "data-[hovered]:bg-sink data-[hovered]:text-ink",
                  "data-[focused]:bg-sink data-[focused]:text-ink",
                  "data-[selected]:bg-accent-tint data-[selected]:text-ink",
                )}
              >
                {kindDisplayLabel(k)}
              </ListBoxItem>
            ))}
          </ListBox>
        </Popover>
      </ComboBox>
      {inferred && immutableReason === undefined && (
        <span className="flex-shrink-0 text-[12px] text-mute">· inferred</span>
      )}
      {immutableReason !== undefined && (
        <span className="flex-shrink-0 text-[12px] text-mute">· fixed</span>
      )}
      {immutableReason !== undefined && (
        <span id={immutableDescriptionId} className="sr-only">
          {immutableReason}
        </span>
      )}
    </div>
  );
}
