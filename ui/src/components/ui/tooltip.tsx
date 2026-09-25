import type { ReactNode } from "react";
import { Tooltip, type TooltipProps } from "react-aria-components";
import { cn } from "#/lib/cn";

/**
 * The app tooltip: a small ink bubble with ground-coloured text. Wrap the
 * trigger in RAC's `TooltipTrigger`; this is only the bubble. (The name
 * predates Stone & Lamp and is kept for its importers.)
 */
export function VesselTooltip({
  children,
  className,
  placement = "top",
  offset = 4,
  ...props
}: Omit<TooltipProps, "children" | "className"> & {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Tooltip
      {...props}
      placement={placement}
      offset={offset}
      className={cn(
        "z-50 rounded-lg bg-ink px-2.5 py-1 text-[12.5px] text-ground shadow-md",
        className,
      )}
    >
      {children}
    </Tooltip>
  );
}
