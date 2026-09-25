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
      <CheckboxButton className="group relative flex cursor-default items-start gap-2 text-[14px] text-ink outline-none transition-colors data-[disabled]:cursor-not-allowed data-[disabled]:text-mute">
        {({ isSelected, isIndeterminate }) => (
          <>
            <span
              data-slot="checkbox-box"
              className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[5px] bg-sink text-raise shadow-[inset_0_0_0_1.5px_var(--faint)] transition-colors group-data-[selected]:bg-accent group-data-[selected]:shadow-none group-data-[indeterminate]:bg-accent group-data-[indeterminate]:shadow-none group-data-[invalid]:shadow-[inset_0_0_0_1.5px_var(--hot)] group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-accent group-data-[focus-visible]:ring-offset-2 group-data-[focus-visible]:ring-offset-ground group-data-[disabled]:opacity-45"
            >
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
        <Description className="ml-6 text-[12.5px] text-mute">
          {description}
        </Description>
      ) : null}
      <FieldError className="ml-6 text-[12.5px] text-hot">
        {errorMessage}
      </FieldError>
    </CheckboxField>
  );
}
