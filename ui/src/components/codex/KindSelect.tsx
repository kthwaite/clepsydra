import { useEffect, useId, useState } from "react";
import {
  ComboBox,
  Input,
  ListBox,
  ListBoxItem,
  Popover,
} from "react-aria-components";
import { cn } from "#/lib/cn";
import {
  ASSIGNABLE_KINDS,
  type Kind,
  kindLabel,
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
  const [draft, setDraft] = useState(value !== null ? kindLabel(value) : "");

  useEffect(() => {
    setDraft(value !== null ? kindLabel(value) : "");
  }, [value]);

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <ComboBox
        aria-label={ariaLabel ?? "Kind"}
        aria-describedby={describedBy}
        isDisabled={isDisabled || immutableReason !== undefined}
        menuTrigger="focus"
        // QUOTE is renderable but not assignable: it shows in the draft while
        // matching no option key.
        selectedKey={value !== null && OPTION_KEYS.has(value) ? value : null}
        inputValue={draft}
        onInputChange={setDraft}
        onSelectionChange={(k) => {
          // RAC re-commits an exact text match on blur, so the current value
          // arrives here again after an abandoned edit; assigning it would be
          // a redundant mutation.
          if (!k || k === value) return;
          setDraft(value === null ? "" : kindLabel(k as Kind));
          onAssign(k as Kind);
        }}
        className="min-w-0 flex-1"
      >
        <Input
          placeholder={placeholder}
          onBlur={() => setDraft(value !== null ? kindLabel(value) : "")}
          className={cn(
            "h-8 w-full rounded-lg bg-sink px-2.5 text-[13.5px] outline-none transition-colors",
            "placeholder:text-faint",
            "data-[focused]:bg-raise data-[focused]:text-ink data-[focused]:ring-2 data-[focused]:ring-accent",
            "data-[disabled]:cursor-not-allowed data-[disabled]:bg-transparent data-[disabled]:px-0 data-[disabled]:text-mute",
            inferred ? "text-mute" : "text-ink",
          )}
        />
        <Popover className="min-w-[180px] rounded-xl bg-raise p-1 shadow-lg outline-none">
          <ListBox className="max-h-[280px] overflow-auto outline-none">
            {OPTIONS.map((k) => (
              <ListBoxItem
                key={k}
                id={k}
                textValue={kindLabel(k)}
                className={cn(
                  "cursor-pointer rounded-lg px-2.5 py-1.5 text-[13.5px] text-ink-2 outline-none",
                  "data-[hovered]:bg-sink data-[hovered]:text-ink",
                  "data-[focused]:bg-sink data-[focused]:text-ink",
                  "data-[selected]:bg-accent-tint data-[selected]:text-ink",
                )}
              >
                {kindLabel(k)}
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
