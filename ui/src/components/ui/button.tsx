import {
  composeRenderProps,
  Button as RACButton,
  type ButtonProps as RACButtonProps,
} from "react-aria-components";
import { cn } from "#/components/ui/utils";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "icon";

export interface ButtonProps extends RACButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const base =
  "inline-flex items-center justify-center gap-1.5 border text-xs uppercase tracking-wider transition-colors data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[focus-visible]:outline data-[focus-visible]:outline-2 data-[focus-visible]:outline-ring data-[focus-visible]:outline-offset-2";

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "border-border bg-primary text-primary-foreground data-[hovered]:bg-primary/90",
  secondary:
    "border-border bg-background text-muted-foreground data-[hovered]:bg-accent data-[hovered]:text-foreground",
  ghost:
    "border-transparent text-muted-foreground data-[hovered]:bg-accent data-[hovered]:text-foreground",
  danger:
    "border-destructive bg-destructive text-destructive-foreground data-[hovered]:bg-destructive/90",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "px-3 py-1 text-sm font-medium normal-case tracking-normal",
  md: "px-3 py-1.5",
  icon: "h-7 w-7 p-0",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonProps) {
  return (
    <RACButton
      {...props}
      className={composeRenderProps(className, (prev) =>
        cn(base, variantClasses[variant], sizeClasses[size], prev),
      )}
    />
  );
}
