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
    <div className="flex min-w-[78px] flex-col gap-[3px]">
      <span className="cl-mono text-[var(--fs-xs)] uppercase tracking-[0.16em] text-[var(--ink-3)]">
        {label}
      </span>
      <b
        className="cl-display text-[20px] font-black leading-none [font-variant-numeric:tabular-nums]"
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
      className={cn(
        "block border border-[var(--rule)] bg-[var(--bg-3)]",
        className,
      )}
    >
      <i
        className="block h-full"
        style={{
          width: `${percent}%`,
          background: isComplete ? "var(--cool)" : "var(--ink-2)",
        }}
        data-testid={indicatorTestId}
      />
    </span>
  );
}
