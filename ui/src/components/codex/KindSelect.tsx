import { useId } from "react";
import {
  Button,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
} from "react-aria-components";
import { cn } from "#/lib/cn";
import { KINDS, type Kind, kindLabel } from "#/lib/kind";

export interface KindSelectProps {
  value: Kind;
  inferred: boolean;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  immutableReason?: string;
  onAssign: (kind: Kind) => void;
}

export function KindSelect({
  value,
  inferred,
  ariaLabel,
  ariaDescribedBy,
  immutableReason,
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

  return (
    <Select
      aria-label={ariaLabel ?? "Kind"}
      aria-describedby={describedBy}
      isDisabled={immutableReason !== undefined}
      selectedKey={value}
      onSelectionChange={(k) => onAssign(k as Kind)}
    >
      <Button
        className={cn(
          "cl-mono inline-flex cursor-pointer items-center gap-1.5 border border-rule px-1.5 py-[2px] text-[11px] uppercase tracking-[0.08em] outline-none transition-colors",
          "data-[hovered]:border-accent data-[hovered]:text-ink",
          "data-[focus-visible]:outline data-[focus-visible]:outline-1 data-[focus-visible]:outline-accent",
          "data-[disabled]:cursor-not-allowed data-[disabled]:text-ink-mute",
          inferred ? "text-ink-mute" : "text-ink-2",
        )}
      >
        <span>{kindLabel(value)}</span>
        {inferred && immutableReason === undefined && (
          <span className="text-[9px] tracking-[0.12em] text-ink-mute">
            · inferred
          </span>
        )}
        {immutableReason !== undefined && (
          <span className="text-[9px] tracking-[0.12em] text-ink-mute">
            · fixed
          </span>
        )}
      </Button>
      {immutableReason !== undefined && (
        <span id={immutableDescriptionId} className="sr-only">
          {immutableReason}
        </span>
      )}
      <Popover className="border border-rule bg-paper outline-none">
        <ListBox className="cl-mono max-h-[280px] overflow-auto p-0.5 outline-none">
          {KINDS.map((k) => (
            <ListBoxItem
              key={k}
              id={k}
              className={cn(
                "cursor-pointer px-2 py-1 text-[11px] uppercase tracking-[0.08em] text-ink-2 outline-none",
                "data-[hovered]:bg-highlight data-[hovered]:text-ink",
                "data-[focused]:bg-highlight data-[focused]:text-ink",
                "data-[selected]:font-bold data-[selected]:text-ink",
              )}
            >
              {kindLabel(k)}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}
