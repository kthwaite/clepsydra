import {
  composeRenderProps,
  Button as RACButton,
  type ButtonProps as RACButtonProps,
} from "react-aria-components";
import { cn } from "#/lib/cn";
import { FOCUS_RING } from "#/lib/focusRing";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "icon";

export interface ButtonProps extends RACButtonProps {
  ref?: React.Ref<HTMLButtonElement>;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const base = cn(
  "inline-flex cursor-pointer items-center justify-center gap-1.5 font-medium transition-colors data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45",
  FOCUS_RING,
);

/** Stone & Lamp button looks (spec §5.5). `secondary` is the spec's
 *  "quiet" button; `ghost` is text only. */
const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "rounded-full bg-accent text-raise data-[hovered]:bg-accent/90 data-[pressed]:bg-accent/85",
  secondary:
    "rounded-[14px] bg-sink text-ink data-[hovered]:bg-sink/70 data-[pressed]:bg-sink/60",
  ghost:
    "rounded-full text-mute data-[hovered]:bg-sink data-[hovered]:text-ink",
  danger:
    "rounded-full bg-hot text-raise data-[hovered]:bg-hot/90 data-[pressed]:bg-hot/85",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 px-3.5 text-[13px]",
  md: "h-11 px-5 text-[14px]",
  icon: "h-8 w-8 rounded-full p-0",
};

/** Shared visual contract for buttons and router links presented as buttons. */
export function buttonStyles(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
  className?: string,
) {
  return cn(base, variantClasses[variant], sizeClasses[size], className);
}

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
        buttonStyles(variant, size, prev),
      )}
    />
  );
}
