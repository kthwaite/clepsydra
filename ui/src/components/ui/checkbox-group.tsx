import type { ReactElement, ReactNode } from "react";
import {
  composeRenderProps,
  FieldError,
  Label,
  CheckboxGroup as RACCheckboxGroup,
  type CheckboxGroupProps as RACCheckboxGroupProps,
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
        <Label className="text-[12.5px] text-mute">{label}</Label>
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
        <Description className="text-[12.5px] text-mute">
          {description}
        </Description>
      ) : null}
      <FieldError className="text-[12.5px] text-hot">{errorMessage}</FieldError>
    </RACCheckboxGroup>
  );
}
