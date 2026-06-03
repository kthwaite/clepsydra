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

export interface TextFieldProps extends RACTextFieldProps {
  label: string;
  description?: string;
  errorMessage?: string | ((validation: ValidationResult) => string);
  placeholder?: string;
}

export function TextField({
  label,
  description,
  errorMessage,
  placeholder,
  className,
  ...props
}: TextFieldProps) {
  return (
    <RACTextField {...props} className={cn("group flex flex-col", className)}>
      <Label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
        {label}
      </Label>
      <Input
        placeholder={placeholder}
        className="mt-2 w-full border border-input bg-background px-3 py-2 text-sm outline-none data-[focused]:border-ring data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
      />
      {description && (
        <Text slot="description" className="mt-2 text-xs text-muted-foreground">
          {description}
        </Text>
      )}
      <FieldError className="mt-2 text-xs text-destructive">
        {errorMessage}
      </FieldError>
    </RACTextField>
  );
}
