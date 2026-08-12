import type { ReactElement, ReactNode } from "react";
import {
  CheckboxGroup as RACCheckboxGroup,
  type CheckboxGroupProps as RACCheckboxGroupProps,
  composeRenderProps,
  FieldError,
  Label,
  type ValidationResult,
} from "react-aria-components";
import { Description } from "#/components/ui/form";
import { cn } from "#/lib/cn";

export interface CheckboxGroupProps
  extends Omit<RACCheckboxGroupProps, "children"> {
  label?: string;
  description?: string;
  errorMessage?: string | ((validation: ValidationResult) => string);
  children?: ReactNode;
  orientation?: "horizontal" | "vertical";
}

export function CheckboxGroup({
  label,
  description,
  errorMessage,
  children,
  orientation = "vertical",
  className,
  ...props
}: CheckboxGroupProps): ReactElement {
  return (
    <RACCheckboxGroup
      {...props}
      data-orientation={orientation}
      className={composeRenderProps(className, (className) =>
        cn("flex flex-col gap-1.5", className),
      )}
    >
      {label ? (
        <Label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
          {label}
        </Label>
      ) : null}
      <div
        className={cn(
          "flex",
          orientation === "horizontal"
            ? "flex-row flex-wrap gap-3"
            : "flex-col gap-2",
        )}
      >
        {children}
      </div>
      {description ? (
        <Description className="text-xs text-muted-foreground">
          {description}
        </Description>
      ) : null}
      <FieldError className="text-xs text-destructive">
        {errorMessage}
      </FieldError>
    </RACCheckboxGroup>
  );
}
