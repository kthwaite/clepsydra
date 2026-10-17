import type {
  Aggregate,
  BaseMetric,
  BasePropertyEntry,
  RowColor,
} from "#/api/bases";
import { formatNumber } from "./cells/NumberDisplay";
import { type CellValue, formatCellValue } from "./cells/types";
import { useIdentifiedRows } from "./ordered-list";
import { propertyKey } from "./property-schema";

const ROW_COLORS: Record<RowColor, { label: string; token: string }> = {
  sepia: { label: "Sepia", token: "var(--quire-sepia)" },
  verdigris: { label: "Verdigris", token: "var(--quire-verdigris)" },
  slate: { label: "Slate", token: "var(--quire-slate)" },
  madder: { label: "Madder", token: "var(--quire-madder)" },
  ochre: { label: "Ochre", token: "var(--quire-ochre)" },
  indigo: { label: "Indigo", token: "var(--quire-indigo)" },
};

export function rowColor(color: RowColor | null | undefined) {
  return color ? ROW_COLORS[color] : undefined;
}

export function formatAggregateValue(
  value: unknown,
  aggregate: Aggregate | undefined,
  properties: readonly BasePropertyEntry[] | null | undefined,
): string {
  if (value == null || (typeof value === "number" && !Number.isFinite(value)))
    return "—";
  const property = aggregate?.field
    ? properties?.find(
        (entry) =>
          propertyKey(entry.key) === propertyKey(aggregate.field ?? ""),
      )?.definition
    : undefined;
  return aggregate?.fn === "percent_filled" && typeof value === "number"
    ? `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
    : typeof value === "number" &&
        property?.type === "number" &&
        aggregate &&
        !aggregate.fn.startsWith("count")
      ? formatNumber(value, property)
      : formatCellValue(value as CellValue);
}

export function BaseMetrics({
  definitions,
  values,
  properties,
}: {
  definitions: readonly BaseMetric[];
  values: readonly unknown[];
  properties: readonly BasePropertyEntry[] | null | undefined;
}) {
  const { rows } = useIdentifiedRows(definitions, "metric-card");
  if (definitions.length === 0) return null;
  return (
    <section aria-label="View metrics" className="flex flex-col gap-2">
      <p className="text-[12.5px] text-mute">Entire filtered view</p>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-3">
        {rows.map(({ id, value: metric }, index) => {
          const value = values[index];
          const label =
            metric.label ??
            (metric.field ? `${metric.fn}(${metric.field})` : metric.fn);
          const formatted = formatAggregateValue(value, metric, properties);
          const target = metric.target;
          const progress =
            typeof value === "number" &&
            Number.isFinite(value) &&
            typeof target === "number" &&
            Number.isFinite(target) &&
            target > 0
              ? { target, bounded: Math.max(0, Math.min(target, value)) }
              : undefined;
          return (
            <div key={id} className="min-w-0 rounded-xl bg-raise px-4 py-3">
              <dt className="break-words text-[13px] text-mute">{label}</dt>
              <dd className="mt-1 break-words text-[22px] text-ink tabular-nums">
                {formatted}
              </dd>
              {progress ? (
                <dd className="mt-2">
                  <div
                    role="progressbar"
                    aria-label={label}
                    aria-valuemin={0}
                    aria-valuemax={progress.target}
                    aria-valuenow={progress.bounded}
                    aria-valuetext={`${formatted} of ${formatAggregateValue(progress.target, metric, properties)}`}
                    className="h-1.5 overflow-hidden rounded-full bg-sink"
                  >
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{
                        width: `${(progress.bounded / progress.target) * 100}%`,
                      }}
                    />
                  </div>
                  <span className="mt-1 block text-[12.5px] text-mute">
                    Target{" "}
                    {formatAggregateValue(progress.target, metric, properties)}
                  </span>
                </dd>
              ) : null}
            </div>
          );
        })}
      </dl>
    </section>
  );
}
