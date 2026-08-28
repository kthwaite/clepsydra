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
        "cl-mono z-50 border border-rule px-2 py-0.5 text-[10px] tracking-[0.08em] text-ink",
        className,
      )}
      style={{ background: "#15140f", borderLeft: "2px solid var(--accent)" }}
    >
      {children}
    </Tooltip>
  );
}
