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
      className={cn("[&_svg]:h-4 [&_svg]:w-4", className)}
    >
      {children}
    </Button>
  );
}
