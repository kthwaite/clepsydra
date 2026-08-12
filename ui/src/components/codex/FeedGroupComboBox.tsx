import { useEffect, useMemo, useRef, useState } from "react";
import {
  ComboBox,
  Input,
  ListBox,
  ListBoxItem,
  Popover,
} from "react-aria-components";
import { cn } from "#/lib/cn";

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
          "mt-1 block w-full min-w-0 border border-rule bg-paper px-2 py-2 text-[12px] normal-case tracking-normal text-ink outline-none transition-colors",
          "placeholder:text-ink-mute",
          "data-[hovered]:border-accent",
          "data-[focused]:border-accent",
          "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60",
        )}
      />
      <Popover className="border border-rule bg-paper outline-none">
        <ListBox className="cl-mono max-h-[280px] overflow-auto p-0.5 outline-none">
          {options.map((group) => (
            <ListBoxItem
              key={group}
              id={group}
              textValue={group}
              className={cn(
                "cursor-pointer px-2 py-1 text-[11px] tracking-[0.04em] text-ink-2 outline-none",
                "data-[hovered]:bg-highlight data-[hovered]:text-ink",
                "data-[focused]:bg-highlight data-[focused]:text-ink",
                "data-[selected]:font-bold data-[selected]:text-ink",
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
