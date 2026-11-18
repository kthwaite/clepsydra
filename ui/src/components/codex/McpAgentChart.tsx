import { useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { McpStatsResponse } from "#/api/mcp";
import {
  type AgentMetric,
  agentSeries,
} from "#/components/codex/mcpAgentSeries";

const dayMs = 86_400_000;
const dateAt = (day: number) =>
  new Date(day * dayMs).toISOString().slice(0, 10);
const number = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});
const tick = { fill: "var(--mute)", fontSize: 12 };
const colours = [
  "var(--accent)",
  "var(--quire-verdigris)",
  "var(--quire-madder)",
  "var(--quire-ochre)",
  "var(--quire-indigo)",
  "var(--quire-slate)",
  "var(--quire-sepia)",
];

function seriesColour(index: number) {
  if (index < colours.length) return colours[index];
  // Distribute additional hues around the colour wheel rather than repeating swatches.
  const hue = (index * 137.508) % 360;
  return `light-dark(oklch(48% 0.14 ${hue}), oklch(76% 0.13 ${hue}))`;
}

function reading(value: number | undefined, metric: AgentMetric) {
  if (metric === "calls") {
    return `${number.format(value ?? 0)} ${value === 1 ? "call" : "calls"}`;
  }
  return value == null ? "No calls" : `${number.format(value)} ms`;
}

type Props = {
  rows: McpStatsResponse["daily_agents"];
  first: number;
  last: number;
  inspect: string;
  metric: AgentMetric;
};

export default function McpAgentChart({
  rows,
  first,
  last,
  inspect,
  metric,
}: Props) {
  const { agents, points } = useMemo(
    () => agentSeries(rows, first, last, metric),
    [rows, first, last, metric],
  );
  const inspectedDay = Date.parse(`${inspect}T00:00:00Z`) / dayMs;
  const inspected = points.find((point) => point.day === inspectedDay);
  const calls = metric === "calls";
  const title = calls
    ? "Calls per UTC day"
    : "Average duration (ms) per UTC day";
  return (
    <figure
      aria-label="Daily by agent"
      className="@container m-0 min-w-0 space-y-3 rounded-xl bg-raise p-4"
    >
      <figcaption className="text-[15px] font-medium text-ink">
        Daily by agent
      </figcaption>
      <p className="m-0 text-[13px] text-mute">{title}</p>
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart
          accessibilityLayer
          title={`${title} by agent`}
          desc="Use the left and right arrow keys to inspect dates."
          data={points}
        >
          <CartesianGrid vertical={false} stroke="var(--rule)" />
          <XAxis
            type="number"
            dataKey="day"
            domain={[first - 0.5, last + 0.5]}
            ticks={first === last ? [first] : [first, last]}
            tickFormatter={dateAt}
            interval="preserveStartEnd"
            tick={tick}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            width="auto"
            allowDecimals={!calls}
            tick={tick}
            tickLine={false}
            axisLine={false}
          />
          <ReferenceLine
            x={inspectedDay}
            stroke="var(--mute)"
            strokeDasharray="3 3"
          />
          <Tooltip
            shared
            filterNull={false}
            isAnimationActive={false}
            cursor={{ stroke: "var(--mute)" }}
            labelFormatter={(day) => `${dateAt(Number(day))} UTC`}
            formatter={(value) =>
              reading(typeof value === "number" ? value : undefined, metric)
            }
            wrapperStyle={{
              zIndex: 1,
              maxWidth: "min(18rem, calc(100cqi - 3rem))",
            }}
            contentStyle={{
              backgroundColor: "var(--ground)",
              border: 0,
              borderRadius: 12,
              boxShadow: "0 4px 16px var(--scrim)",
              color: "var(--ink)",
              fontSize: 13,
              overflowWrap: "anywhere",
              whiteSpace: "normal",
            }}
          />
          {agents.map(({ name, key }, index) =>
            calls ? (
              <Bar
                key={key}
                dataKey={key}
                name={name}
                stackId="calls"
                maxBarSize={32}
                fill={seriesColour(index)}
                isAnimationActive={false}
              />
            ) : (
              <Line
                key={key}
                dataKey={key}
                name={name}
                type="linear"
                connectNulls={false}
                stroke={seriesColour(index)}
                strokeWidth={2}
                dot={{ r: 3, fill: seriesColour(index) }}
                isAnimationActive={false}
              />
            ),
          )}
        </ComposedChart>
      </ResponsiveContainer>
      <div
        aria-live="polite"
        className="space-y-1 text-[13px] tabular-nums text-ink-2"
      >
        <time dateTime={inspect}>{inspect} UTC</time>
        <dl className="m-0 flex flex-wrap gap-x-5 gap-y-1">
          {agents.map(({ key, name }, index) => (
            <div key={key} className="flex max-w-full items-baseline gap-2">
              <dt className="min-w-0 [overflow-wrap:anywhere]">
                <span
                  aria-hidden="true"
                  className="mr-1.5 inline-block size-2.5 rounded-full"
                  style={{ backgroundColor: seriesColour(index) }}
                />
                {name}
              </dt>
              <dd className="m-0 shrink-0 font-medium text-ink">
                {reading(inspected?.[key], metric)}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </figure>
  );
}
