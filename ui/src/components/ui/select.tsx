import { ChevronDown } from "lucide-react";
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
import { DropdownItem, DropdownListBox } from "#/components/ui/list-box";
import { cn } from "#/lib/cn";
import { Button } from "./button";
import { Description } from "./form";
import { Popover } from "./popover";

export interface SelectProps<T, M extends "single" | "multiple">
  extends Omit<AriaSelectProps<T, M>, "children"> {
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
  ...props
}: SelectProps<T, M>) {
  return (
    <AriaSelect
      {...props}
      className={cn("flex flex-col gap-1 w-fit", props.className)}
    >
      {label && (
        <Label className="cl-mono min-w-0 text-[9px] uppercase tracking-[0.16em] text-ink-mute">
          {label}
        </Label>
      )}
      <Button className="p-1 shrink">
        <SelectValue />
        <ChevronDown size={16} />
      </Button>
      {description && <Description>{description}</Description>}
      <FieldError>{errorMessage}</FieldError>
      <Popover hideArrow className="">
        <SelectListBox items={items}>{children}</SelectListBox>
      </Popover>
    </AriaSelect>
  );
}

export function SelectListBox<T>(props: ListBoxProps<T>) {
  return (
    <DropdownListBox
      {...props}
      className="border flex flex-col gap-1 p-1 shadow-lg bg-paper"
    />
  );
}

export function SelectItem(props: ListBoxItemProps) {
  return (
    <DropdownItem
      {...props}
      className="p-1 hover:bg-paper-edge outline-none flex flex-row items-center gap-2"
    />
  );
}
