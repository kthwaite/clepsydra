import { composeRenderProps, TooltipTrigger } from "react-aria-components";
import { Button, type ButtonProps } from "#/components/ui/button";
import { VesselTooltip } from "#/components/ui/tooltip";
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
      className={composeRenderProps(className, (value) =>
        cn("[&_svg]:h-4 [&_svg]:w-4", value),
      )}
    >
      {children}
    </Button>
  );
}

/** A named icon action with the same tooltip, focus reveal and touch target. */
export function TooltipIconButton({ className, ...props }: IconButtonProps) {
  return (
    <TooltipTrigger delay={300} closeDelay={0}>
      <IconButton
        {...props}
        className={composeRenderProps(className, (value) =>
          cn("data-[focus-visible]:opacity-100 max-md:h-11 max-md:w-11", value),
        )}
      />
      <VesselTooltip>{props["aria-label"]}</VesselTooltip>
    </TooltipTrigger>
  );
}
