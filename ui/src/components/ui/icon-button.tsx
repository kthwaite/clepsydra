import { Button, type ButtonProps } from "#/components/ui/button";
import { cn } from "#/lib/cn";

interface IconButtonProps extends Omit<ButtonProps, "size"> {
  "aria-label": string;
}

export function IconButton({ children, className, ...props }: IconButtonProps) {
  return (
    <Button
      {...props}
      size="icon"
      variant={props.variant ?? "ghost"}
      className={cn("[&_svg]:h-4 [&_svg]:w-4", className)}
    >
      {children}
    </Button>
  );
}
