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
