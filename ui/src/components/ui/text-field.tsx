import type { Ref } from "react";
import {
  FieldError,
  Input,
  Label,
  TextField as RACTextField,
  type TextFieldProps as RACTextFieldProps,
  Text,
  type ValidationResult,
} from "react-aria-components";
import { cn } from "#/lib/cn";
import { FOCUS_RING } from "#/lib/focusRing";

export interface TextFieldProps extends RACTextFieldProps {
  label: string;
  description?: string;
  errorMessage?: string | ((validation: ValidationResult) => string);
  placeholder?: string;
  inputRef?: Ref<HTMLInputElement>;
}

export function TextField({
  label,
  description,
  errorMessage,
  placeholder,
  inputRef,
  className,
  ...props
}: TextFieldProps) {
  return (
    <RACTextField {...props} className={cn("group flex flex-col", className)}>
      <Label className="text-[12.5px] text-mute">{label}</Label>
      <Input
        ref={inputRef}
        placeholder={placeholder}
        className={cn(
          "mt-1.5 h-10 w-full rounded-full bg-sink px-4 text-[14px] text-ink placeholder:text-mute data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 data-[invalid]:ring-2 data-[invalid]:ring-hot",
          FOCUS_RING,
        )}
      />
      {description && (
        <Text slot="description" className="mt-1.5 text-[12.5px] text-mute">
          {description}
        </Text>
      )}
      <FieldError className="mt-1.5 text-[12.5px] text-hot">
        {errorMessage}
      </FieldError>
    </RACTextField>
  );
}
