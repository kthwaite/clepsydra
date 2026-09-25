import { cn } from "#/lib/cn";
import { pad2 } from "#/lib/time";

export interface CycleMetricProps {
  label: string;
  value: number | string;
  testId: string;
  color?: string;
}

export function CycleMetric({ label, value, testId, color }: CycleMetricProps) {
  return (
    <div className="flex min-w-[78px] flex-col gap-1">
      <span className="text-[12.5px] text-mute">{label}</span>
      <b
        className="font-serif text-[26px] font-normal leading-none tabular-nums"
        style={color ? { color } : undefined}
        data-testid={testId}
      >
        {typeof value === "number" ? pad2(value) : value}
      </b>
    </div>
  );
}

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
