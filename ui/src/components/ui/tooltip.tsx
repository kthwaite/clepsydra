import type { ReactNode } from "react";
import { Tooltip, type TooltipProps } from "react-aria-components";
import { cn } from "#/lib/cn";

/**
 * The Vessel tooltip: mono, hard-edged, accent left rule. Wrap the trigger in
 * RAC's `TooltipTrigger`; this is only the bubble.
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
        "cl-serif z-50 border border-rule border-l-2 border-l-accent bg-paper-2 px-2 py-0.5  tracking-[0.08em] text-ink",
        className,
      )}
    >
      {children}
    </Tooltip>
  );
}
