import { ChevronDown } from "lucide-react";
import { composeRenderProps } from "react-aria-components/composeRenderProps";
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
      {label && (
        <Label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
          {label}
        </Label>
      )}
      <Button className="w-full min-w-0 justify-between text-start">
        <SelectValue className="min-w-0 flex-1 truncate text-sm normal-case tracking-normal data-[placeholder]:text-muted-foreground" />
        <ChevronDown
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground group-data-[disabled]:opacity-50"
        />
      </Button>
      {description && (
        <Description className="text-xs text-muted-foreground">
          {description}
        </Description>
      )}
      <FieldError className="text-xs text-destructive">
        {errorMessage}
      </FieldError>
      <Popover
        hideArrow
        className="min-w-(--trigger-width) border border-border bg-popover text-popover-foreground shadow-lg"
      >
        <SelectListBox items={items}>{children}</SelectListBox>
      </Popover>
    </AriaSelect>
  );
}

export function SelectListBox<T>({
  className,
  ...props
}: ListBoxProps<T>) {
  return (
    <DropdownListBox
      {...props}
      className={composeRenderProps(className, (className) =>
        cn("max-h-64 overflow-auto p-1 outline-none", className),
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
        (
          className,
          { isDisabled, isFocused, isHovered, isSelected },
        ) =>
          cn(
            "flex cursor-default items-center gap-2 p-2 text-sm outline-none transition-colors",
            (isHovered || isFocused) &&
              "bg-accent text-accent-foreground",
            isSelected &&
              "bg-accent font-medium text-accent-foreground",
            isDisabled && "pointer-events-none opacity-50",
            className,
          ),
      )}
    />
  );
}
