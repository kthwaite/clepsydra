import type { ReactNode } from "react";
import { cn } from "#/components/ui/utils";

export interface SectionHeadingProps {
  children: ReactNode;
  className?: string;
}

export function SectionHeading({ children, className }: SectionHeadingProps) {
  return (
    <h2
      className={cn(
        "mb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground",
        className,
      )}
    >
      {children}
    </h2>
  );
}
