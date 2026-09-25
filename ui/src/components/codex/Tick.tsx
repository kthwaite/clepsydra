import { cn } from "#/lib/cn";

export type TickVariant = "live" | "pulse" | "faint";

const TICK: Record<TickVariant, string> = {
  live: "bg-accent",
  pulse: "bg-accent animate-pulse",
  faint: "bg-faint",
};

/** The section tick (spec decision 6): a 7px square in front of every
 *  eyebrow — cobalt when live, pulsing when streaming, faint when dimmed. */
export function Tick({
  variant = "live",
  className,
}: {
  variant?: TickVariant;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-tick
      className={cn(
        "inline-block h-[7px] w-[7px] flex-shrink-0 rounded-[1px]",
        TICK[variant],
        className,
      )}
    />
  );
}
