import { ChevronDown } from "lucide-react";
import { composeRenderProps } from "react-aria-components/composeRenderProps";
import type { ListBoxSectionProps } from "react-aria-components/ListBox";
import {
  Select as AriaSelect,
  type SelectProps as AriaSelectProps,
  FieldError,
  Label,
  type ListBoxItemProps,
  type ListBoxProps,
  SelectValue,
  type ValidationResult,
} from "react-aria-components/Select";
import {
  DropdownItem,
  DropdownListBox,
  ListBoxSection,
} from "#/components/ui/list-box";
import { cn } from "#/lib/cn";
import { Button } from "./button";
import { Description } from "./form";
import { Popover } from "./popover";

export interface SelectProps<T, M extends "single" | "multiple">
  extends Omit<AriaSelectProps<T, M>, "children"> {
  triggerRef?: React.Ref<HTMLButtonElement>;
  label?: string;
  description?: string;
  errorMessage?: string | ((validation: ValidationResult) => string);
  items?: Iterable<T>;
  children: React.ReactNode | ((item: T) => React.ReactNode);
}

export function Select<T, M extends "single" | "multiple" = "single">({
  label,
  description,
  errorMessage,
  children,
  items,
  triggerRef,
  className,
  ...props
}: SelectProps<T, M>) {
  return (
    <AriaSelect
      {...props}
      className={composeRenderProps(className, (className) =>
        cn("group relative flex w-full flex-col gap-1", className),
      )}
    >
      {label && <Label className="text-[12.5px] text-mute">{label}</Label>}
      <Button
        ref={triggerRef}
        className="h-10 w-full min-w-0 justify-between rounded-full px-4 text-start text-[14px] font-normal group-data-[invalid]:ring-2 group-data-[invalid]:ring-hot"
      >
        <SelectValue className="min-w-0 flex-1 truncate text-[14px] data-[placeholder]:text-mute" />
        <ChevronDown
          aria-hidden
          className="size-4 shrink-0 text-mute group-data-[disabled]:opacity-45"
        />
      </Button>
      {description && (
        <Description className="text-[12.5px] text-mute">
          {description}
        </Description>
      )}
      <FieldError className="text-[12.5px] text-hot">{errorMessage}</FieldError>
      <Popover
        hideArrow
        className="min-w-(--trigger-width) rounded-xl bg-raise text-ink shadow-lg"
      >
        <SelectListBox items={items}>{children}</SelectListBox>
      </Popover>
    </AriaSelect>
  );
}

export function SelectListBox<T>({ className, ...props }: ListBoxProps<T>) {
  return (
    <DropdownListBox
      {...props}
      className={composeRenderProps(className, (className) =>
        cn("max-h-64 overflow-auto p-1.5 outline-none", className),
      )}
    />
  );
}

export function SelectSection<T>({
  className,
  ...props
}: ListBoxSectionProps<T>) {
  return (
    <ListBoxSection
      {...props}
      className={cn(
        "py-1 first:pt-0 last:pb-0 [&>header]:px-3 [&>header]:pt-2 [&>header]:pb-1 [&>header]:text-[12px] [&>header]:text-mute",
        className,
      )}
    />
  );
}

export function SelectItem({ className, ...props }: ListBoxItemProps) {
  return (
    <DropdownItem
      {...props}
      className={composeRenderProps(
        className,
        (className, { isDisabled, isFocused, isHovered, isSelected }) =>
          cn(
            "flex cursor-default items-center gap-2 rounded-lg px-3 py-1.5 text-[13.5px] text-ink outline-none transition-colors",
            (isHovered || isFocused) && "bg-sink",
            isSelected && "bg-accent-tint font-medium",
            isDisabled && "pointer-events-none opacity-45",
            className,
          ),
      )}
    />
  );
}
