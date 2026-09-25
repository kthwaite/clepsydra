import type { ReactNode } from "react";
import { Tick, type TickVariant } from "#/components/codex/Tick";
import { cn } from "#/lib/cn";

type Pip = "cool" | "hot" | "dim";
const PIP_TICK: Record<Pip, TickVariant> = {
  cool: "live",
  hot: "pulse",
  dim: "faint",
};

/** A titled block (spec §5.4): tick + italic serif eyebrow + caption +
 *  action, then the body indented to the eyebrow. No border, band or fill. */
export function Section({
  label,
  caption,
  action,
  pip = "cool",
  tight = false,
  compact = false,
  wrapHeader = false,
  className,
  children,
}: {
  label: string;
  caption?: ReactNode;
  action?: ReactNode;
  pip?: Pip;
  tight?: boolean;
  /** Rail size: 18px muted eyebrow, tighter gaps, 17px body indent. */
  compact?: boolean;
  wrapHeader?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col",
        compact ? "gap-3.5" : "gap-[22px]",
        className,
      )}
    >
      <div
        className={cn(
          "flex items-center",
          compact ? "gap-2.5" : "gap-3",
          wrapHeader && "min-w-0 flex-wrap",
        )}
      >
        <Tick variant={PIP_TICK[pip]} />
        <h2
          className={cn(
            "truncate font-serif italic leading-none",
            compact ? "text-[18px] text-mute" : "text-[22px] text-ink",
          )}
        >
          {label}
        </h2>
        {caption ? (
          <span
            data-section-caption
            className={cn(
              "text-[13px] text-mute",
              wrapHeader ? "whitespace-normal" : "whitespace-nowrap",
            )}
          >
            {caption}
          </span>
        ) : null}
        <span className="flex-1" />
        {action ? (
          <div
            className={cn(
              "flex items-center gap-2.5 text-[13.5px] text-accent",
              wrapHeader ? "min-w-0 flex-wrap" : "flex-shrink-0",
            )}
          >
            {action}
          </div>
        ) : null}
      </div>
      <div
        data-section-body
        className={cn(
          "min-w-0",
          !tight && (compact ? "pl-[17px]" : "pl-[19px]"),
        )}
      >
        {children}
      </div>
    </section>
  );
}
