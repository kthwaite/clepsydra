import type { ReactNode } from "react";
import { cn } from "#/lib/cn";

type BadgeSize = "sm" | "md";

export interface BadgeProps {
  children: ReactNode;
  size?: BadgeSize;
  className?: string;
}

const sizeClasses: Record<BadgeSize, string> = {
  sm: "px-1.5 text-[11.5px]",
  md: "px-2 py-0.5 text-[12px]",
};

export function Badge({ children, size = "md", className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full bg-sink text-ink-2 tabular-nums",
        sizeClasses[size],
        className,
      )}
    >
      {children}
    </span>
  );
}
