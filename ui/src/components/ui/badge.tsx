import type { ReactNode } from "react";
import { cn } from "#/lib/cn";

type BadgeSize = "sm" | "md";

export interface BadgeProps {
  children: ReactNode;
  size?: BadgeSize;
  className?: string;
}

const sizeClasses: Record<BadgeSize, string> = {
  sm: "px-1 py-px text-[10px]",
  md: "px-2 py-0.5 text-xs",
};

export function Badge({ children, size = "md", className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center border border-border font-mono uppercase tracking-wider text-muted-foreground",
        sizeClasses[size],
        className,
      )}
    >
      {children}
    </span>
  );
}
