import { useEffect, useMemo, useRef, useState } from "react";
import {
  ComboBox,
  Input,
  ListBox,
  ListBoxItem,
  Popover,
} from "react-aria-components";
import { cn } from "#/lib/cn";
import { FOCUS_RING } from "#/lib/focusRing";

export interface FeedGroupComboBoxProps {
  value: string;
  groups: string[];
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

function groupKey(value: string): string {
  return value.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

export function canonicalFeedGroups(groups: string[]): string[] {
  const seen = new Set<string>();
  let canonical: string[] | null = null;

  for (const [index, group] of groups.entries()) {
    const spelling = group.trim();
    const key = groupKey(spelling);
    if (!key || seen.has(key)) {
      canonical ??= groups.slice(0, index);
      continue;
    }
    seen.add(key);
    if (canonical) {
      canonical.push(spelling);
    } else if (spelling !== group) {
      canonical = groups.slice(0, index);
      canonical.push(spelling);
    }
  }

  return canonical ?? groups;
}

export function FeedGroupComboBox({
  value,
  groups,
  ariaLabel,
  disabled = false,
  onChange,
}: FeedGroupComboBoxProps) {
  const options = useMemo(() => canonicalFeedGroups(groups), [groups]);
  const optionByKey = useMemo(
    () => new Map(options.map((group) => [groupKey(group), group])),
    [options],
  );
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  const lastCommittedRef = useRef(value);

  useEffect(() => {
    draftRef.current = value;
    lastCommittedRef.current = value;
    setDraft(value);
  }, [value]);

  const setInputDraft = (nextDraft: string) => {
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  };

  const commitValue = (nextValue: string) => {
    if (disabled) return;
    const previousValue = lastCommittedRef.current;
    const key = groupKey(nextValue);
    if (key === groupKey(previousValue)) {
      setInputDraft(optionByKey.get(key) ?? previousValue);
      return;
    }
    lastCommittedRef.current = nextValue;
    setInputDraft(nextValue);
    onChange(nextValue);
  };

  const commitDraft = () => {
    const trimmed = draftRef.current.trim();
    commitValue(optionByKey.get(groupKey(trimmed)) ?? trimmed);
  };

  return (
    <ComboBox
      aria-label={ariaLabel}
      allowsCustomValue
      isDisabled={disabled}
      inputValue={draft}
      defaultFilter={(textValue, inputValue) =>
        groupKey(textValue).includes(groupKey(inputValue))
      }
      onInputChange={setInputDraft}
      onSelectionChange={(key) => {
        if (key !== null) commitValue(String(key));
      }}
      className="min-w-0"
    >
      <Input
        placeholder="Optional"
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.currentTarget.getAttribute("aria-activedescendant")
          ) {
            commitDraft();
          }
        }}
        onBlur={commitDraft}
        className={cn(
          "h-10 w-full min-w-0 rounded-full bg-sink px-4 text-[14px] text-ink placeholder:text-mute",
          "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45",
          FOCUS_RING,
        )}
      />
      <Popover className="min-w-[var(--trigger-width)] rounded-2xl bg-raise p-1.5 shadow-xl outline-none">
        <ListBox className="max-h-[280px] overflow-auto outline-none">
          {options.map((group) => (
            <ListBoxItem
              key={group}
              id={group}
              textValue={group}
              className={cn(
                "cursor-pointer rounded-[10px] px-3 py-2 text-[13.5px] text-ink-2 outline-none",
                "data-[hovered]:bg-sink data-[hovered]:text-ink",
                "data-[focused]:bg-sink data-[focused]:text-ink",
                "data-[selected]:font-medium data-[selected]:text-ink",
              )}
            >
              {group}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </ComboBox>
  );
}
