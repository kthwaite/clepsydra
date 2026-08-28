import { Check, Minus } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useRef } from "react";
import { mergeRefs, useObjectRef } from "react-aria";
import {
  CheckboxButton,
  CheckboxField,
  type CheckboxFieldProps,
  composeRenderProps,
  FieldError,
  type ValidationResult,
} from "react-aria-components";
import { Description } from "#/components/ui/form";
import { cn } from "#/lib/cn";

export interface CheckboxProps extends CheckboxFieldProps {
  children?: ReactNode;
  description?: string;
  errorMessage?: string | ((validation: ValidationResult) => string);
}

export function Checkbox({
  children,
  description,
  errorMessage,
  className,
  inputRef,
  isIndeterminate,
  ...props
}: CheckboxProps): ReactElement {
  const localInputRef = useRef<HTMLInputElement>(null);
  const mergedInputRef = useObjectRef(mergeRefs(inputRef, localInputRef));

  useEffect(() => {
    if (isIndeterminate) {
      localInputRef.current?.setAttribute("aria-checked", "mixed");
    } else {
      localInputRef.current?.removeAttribute("aria-checked");
    }
  }, [isIndeterminate]);

  return (
    <CheckboxField
      inputRef={mergedInputRef}
      isIndeterminate={isIndeterminate}
      {...props}
      className={composeRenderProps(className, (className) =>
        cn("group flex flex-col gap-1", className),
      )}
    >
      <CheckboxButton className="group relative flex cursor-default items-start gap-2 text-sm text-foreground outline-none transition-colors data-[disabled]:cursor-not-allowed data-[disabled]:text-muted-foreground">
        {({ isSelected, isIndeterminate }) => (
          <>
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center border border-input bg-background text-primary-foreground transition-colors group-data-[hovered]:border-ring group-data-[pressed]:bg-accent group-data-[focus-visible]:outline group-data-[focus-visible]:outline-2 group-data-[focus-visible]:outline-ring group-data-[focus-visible]:outline-offset-2 group-data-[invalid]:border-destructive group-data-[selected]:border-primary group-data-[selected]:bg-primary group-data-[indeterminate]:border-primary group-data-[indeterminate]:bg-primary group-data-[disabled]:opacity-50">
              {isIndeterminate ? (
                <Minus aria-hidden className="size-3" />
              ) : isSelected ? (
                <Check aria-hidden className="size-3" />
              ) : null}
            </span>
            <span>{children}</span>
          </>
        )}
      </CheckboxButton>
      {description ? (
        <Description className="ml-6 text-xs text-muted-foreground">
          {description}
        </Description>
      ) : null}
      <FieldError className="ml-6 text-xs text-destructive">
        {errorMessage}
      </FieldError>
    </CheckboxField>
  );
}
