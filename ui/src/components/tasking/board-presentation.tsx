import { cn } from "#/lib/cn";

export interface ChecklistBarProps {
  percent: number;
  isComplete: boolean;
  className?: string;
  indicatorTestId?: string;
}

export function ChecklistBar({
  percent,
  isComplete,
  className,
  indicatorTestId,
}: ChecklistBarProps) {
  return (
    <span
      className={cn("block overflow-hidden rounded-full bg-sink", className)}
    >
      <i
        className="block h-full rounded-full"
        style={{
          width: `${percent}%`,
          background: isComplete ? "var(--accent)" : "var(--mute)",
        }}
        data-testid={indicatorTestId}
      />
    </span>
  );
}

/**
 * Task type as a small pill beside the priority chip. FIX is hot; every
 * other type is mute. Untyped tasks render nothing.
 */
export function TypeChip({ type }: { type?: string | null }) {
  if (!type) return null;
  return (
    <span
      className="inline-block flex-shrink-0 rounded-full bg-sink px-2 text-[12px] leading-5 tabular-nums"
      style={{ color: type === "FIX" ? "var(--hot)" : "var(--mute)" }}
    >
      {type}
    </span>
  );
}
