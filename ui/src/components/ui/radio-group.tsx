import type { ReactNode } from "react";
import {
  composeRenderProps,
  Radio as RACRadio,
  RadioGroup as RACRadioGroup,
  type RadioGroupProps as RACRadioGroupProps,
  type RadioProps as RACRadioProps,
} from "react-aria-components";
import { cn } from "#/lib/cn";

export interface RadioGroupProps extends RACRadioGroupProps {
  label?: string;
  description?: string;
  children?: ReactNode;
}

export function RadioGroup({
  label,
  description,
  className,
  children,
  ...props
}: RadioGroupProps) {
  return (
    <RACRadioGroup
      {...props}
      className={cn("flex flex-col gap-1.5", className)}
    >
      {label && (
        <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
          {label}
        </span>
      )}
      <div className="flex gap-0">{children}</div>
      {description && (
        <span className="text-xs text-muted-foreground">{description}</span>
      )}
    </RACRadioGroup>
  );
}

export function Radio({ className, ...props }: RACRadioProps) {
  return (
    <RACRadio
      {...props}
      className={composeRenderProps(className, (prev) =>
        cn(
          "cursor-default border border-border px-2 py-1 text-xs uppercase tracking-wider text-muted-foreground outline-none transition-colors",
          "data-[hovered]:bg-accent data-[hovered]:text-foreground",
          "data-[selected]:border-border data-[selected]:bg-accent data-[selected]:font-bold data-[selected]:text-foreground",
          "data-[focus-visible]:outline data-[focus-visible]:outline-2 data-[focus-visible]:outline-ring data-[focus-visible]:outline-offset-2",
          "-ml-px first:ml-0",
          prev,
        ),
      )}
    />
  );
}
