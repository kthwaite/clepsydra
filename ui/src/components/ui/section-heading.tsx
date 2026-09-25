import type { ReactNode } from "react";
import { Tick } from "#/components/codex/Tick";
import { cn } from "#/lib/cn";

export interface SectionHeadingProps {
  children: ReactNode;
  className?: string;
}

/** A lightweight eyebrow: tick + italic serif title, for places that do not
 *  need a full Section. */
export function SectionHeading({ children, className }: SectionHeadingProps) {
  return (
    <h2
      className={cn(
        "mb-3 flex items-center gap-3 font-serif text-[20px] italic leading-none text-ink",
        className,
      )}
    >
      <Tick />
      {children}
    </h2>
  );
}
