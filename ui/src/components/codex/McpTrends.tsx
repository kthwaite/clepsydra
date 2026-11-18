import { type ReactNode, useMemo, useState } from "react";
import type { McpStatsResponse } from "#/api/mcp";
import { Section } from "#/components/codex/Section";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

type Metric = "calls" | "average_duration_ms";
type Day = Pick<McpStatsResponse["daily"][number], "date" | Metric>;
type Agent = { name: string; calls: number; totalMs: number; daily: Day[] };
const labels = { calls: "Calls", average_duration_ms: "Average duration" };
const metrics = ["calls", "average_duration_ms"] as const;
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const control = cn(
  "h-9 min-w-0 max-w-full rounded-xl bg-sink px-3 text-[14px] text-ink",
  FOCUS_RING_NATIVE,
);
const card = "m-0 min-w-0 space-y-3 rounded-xl bg-raise p-4";
const title = "text-[15px] font-medium text-ink";
const dayMs = 86_400_000;
const dayIndex = (date: string) => Date.parse(`${date}T00:00:00Z`) / dayMs;
const dateAt = (day: number) =>
  new Date(day * dayMs).toISOString().slice(0, 10);

function display(value: number, metric: Metric) {
  if (metric === "average_duration_ms") return `${number.format(value)} ms`;
  return `${number.format(value)} ${value === 1 ? "call" : "calls"}`;
}

function agentValue(agent: Agent, metric: Metric) {
  return metric === "calls" ? agent.calls : agent.totalMs / agent.calls;
}

function groupAgents(rows: McpStatsResponse["daily_agents"]) {
  const agents = new Map<string, Agent>();
  for (const row of rows) {
    let agent = agents.get(row.name);
    if (!agent) {
      agent = { name: row.name, calls: 0, totalMs: 0, daily: [] };
      agents.set(row.name, agent);
    }
    agent.calls += row.calls;
    agent.totalMs += row.calls * row.average_duration_ms;
    agent.daily.push(row);
  }
  return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Position observed days on the UTC calendar without allocating empty slots
// for every day in an all-time range. One SVG path paints all nonzero bars.
const width = 600;
const baseline = 96;
function dailyBars(rows: Day[], metric: Metric, first: number, last: number) {
  const peak = rows.reduce((max, row) => Math.max(max, row[metric]), 0);
  const slot = width / (last - first + 1);
  const bar = Math.min(24, Math.max(0.8, slot * 0.72));
  let bars = "";
  let zeros = "";
  for (const row of rows) {
    const x = (dayIndex(row.date) - first + 0.5) * slot;
    const value = row[metric];
    if (value > 0) {
      const y = baseline - (value / peak) * 90;
      bars += `M${x.toFixed(2)} ${baseline}V${y.toFixed(2)}`;
    } else if (row.calls > 0) {
      // A measured 0 ms gets a mark; an unobserved duration gets none.
      zeros += `M${(x - bar / 2).toFixed(2)} ${baseline}h${bar.toFixed(2)}`;
    }
  }
  return { peak, bar, bars, zeros, slot };
}

function DailyPlot({
  label,
  rows,
  metric,
  first,
  last,
  inspect,
  children,
}: {
  label: string;
  rows: Day[];
  metric: Metric;
  first: number;
  last: number;
  inspect: string;
  children?: ReactNode;
}) {
  const { peak, bar, bars, zeros, slot } = useMemo(
    () => dailyBars(rows, metric, first, last),
    [rows, metric, first, last],
  );
  const day = rows.find((row) => row.date === inspect);
  const reading =
    metric === "average_duration_ms" && !day?.calls
      ? "No calls"
      : display(day?.[metric] ?? 0, metric);
  const cursor = (dayIndex(inspect) - first + 0.5) * slot;
  return (
    <figure aria-label={label} className={card}>
      <figcaption className="flex flex-wrap items-center justify-between gap-2">
        <span className={title}>{label}</span>
        {children}
      </figcaption>
      <p className="m-0 text-[13px] text-mute">
        {metric === "calls" ? "Calls" : "Average duration (ms)"} per UTC day
      </p>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-stretch gap-x-2 gap-y-1">
        <div className="flex min-w-8 flex-col justify-between text-right text-[12px] tabular-nums text-mute">
          <span>{peak ? number.format(peak) : ""}</span>
          <span>0</span>
        </div>
        <div className="min-w-0 flex-1">
          <svg
            aria-hidden="true"
            viewBox={`0 0 ${width} 100`}
            preserveAspectRatio="none"
            className="block h-24 w-full"
          >
            <path d={`M0 ${baseline}H${width}`} className="stroke-rule" />
            <path
              d={`M${cursor} 0V${baseline}`}
              strokeDasharray="3 3"
              className="stroke-mute"
            />
            <path d={bars} strokeWidth={bar} className="stroke-accent" />
            <path d={zeros} strokeWidth={3} className="stroke-accent" />
          </svg>
        </div>
        <div
          className={cn(
            "col-start-2 flex text-[12px] tabular-nums text-mute",
            first === last ? "justify-center" : "justify-between",
          )}
        >
          <time dateTime={dateAt(first)}>{dateAt(first)}</time>
          {first !== last ? (
            <time dateTime={dateAt(last)}>{dateAt(last)}</time>
          ) : null}
        </div>
      </div>
      <p aria-live="polite" className="m-0 text-[13px] text-ink-2">
        <span className="sr-only">{label}: </span>
        <time dateTime={inspect}>{inspect}</time> · <strong>{reading}</strong>
      </p>
    </figure>
  );
}

const rankPageSize = 8;
function AgentRanking({ agents, metric }: { agents: Agent[]; metric: Metric }) {
  const [requestedPage, setPage] = useState(0);
  const ranked = useMemo(
    () =>
      [...agents].sort((a, b) => agentValue(b, metric) - agentValue(a, metric)),
    [agents, metric],
  );
  const pages = Math.ceil(ranked.length / rankPageSize);
  const page = Math.min(requestedPage, pages - 1);
  const offset = page * rankPageSize;
  const peak = agentValue(ranked[0], metric);
  return (
    <figure
      aria-label="Agent ranking"
      className={cn(
        card,
        "lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start",
      )}
    >
      <figcaption className={title}>Agent ranking</figcaption>
      <p className="m-0 text-[13px] text-mute">
        {metric === "calls" ? "Total calls" : "Mean duration per call"} across
        the range
      </p>
      <ol
        start={offset + 1}
        className="m-0 list-decimal space-y-3 pl-6 marker:text-mute"
      >
        {ranked.slice(offset, offset + rankPageSize).map((agent) => {
          const value = agentValue(agent, metric);
          return (
            <li key={agent.name} className="text-[13px] text-ink-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                <span className="break-all">{agent.name}</span>
                <span className="whitespace-nowrap tabular-nums">
                  {display(value, metric)}
                </span>
              </div>
              <div
                aria-hidden="true"
                className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-sink"
              >
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${peak ? (value / peak) * 100 : 0}%` }}
                />
              </div>
            </li>
          );
        })}
      </ol>
      {pages > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-mute">
          <Button
            size="sm"
            aria-label="Previous ranked agents"
            isDisabled={page === 0}
            onPress={() => setPage(page - 1)}
          >
            Previous
          </Button>
          {page + 1} / {pages}
          <Button
            size="sm"
            aria-label="Next ranked agents"
            isDisabled={page + 1 === pages}
            onPress={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}
    </figure>
  );
}

export function McpTrends({ data }: { data?: McpStatsResponse }) {
  const [metric, setMetric] = useState<Metric>("calls");
  const [requestedDay, setDay] = useState("");
  const [agentName, setAgentName] = useState("");
  const agents = useMemo(
    () => (data ? groupAgents(data.daily_agents) : []),
    [data],
  );
  const selected =
    agents.find((agent) => agent.name === agentName) ?? agents[0];
  if (!data || !selected) return null;
  const last = dayIndex(data.through_date);
  // A rolling 7 × 24 hours can touch eight UTC dates. Keep both partial days.
  const first = data.days
    ? last - data.days
    : dayIndex(
        data.tracking_since?.slice(0, 10) ??
          data.daily[0]?.date ??
          data.through_date,
      );
  const inspect =
    requestedDay >= dateAt(first) && requestedDay <= data.through_date
      ? requestedDay
      : (data.daily.at(-1)?.date ?? data.through_date);
  return (
    <Section
      label="MCP trends"
      wrapHeader
      action={
        <fieldset className="m-0 flex flex-wrap gap-1 p-0">
          <legend className="sr-only">Trend metric</legend>
          {metrics.map((option) => (
            <Button
              key={option}
              size="sm"
              aria-pressed={metric === option}
              variant={metric === option ? "primary" : "secondary"}
              onPress={() => setMetric(option)}
            >
              {labels[option]}
            </Button>
          ))}
        </fieldset>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <label className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
            Inspect day (UTC)
            <input
              type="date"
              className={control}
              min={dateAt(first)}
              max={data.through_date}
              value={inspect}
              onChange={(event) => setDay(event.target.value)}
            />
          </label>
          <p className="m-0 text-[13px] text-mute">
            {metric === "calls"
              ? "An empty day has zero recorded calls."
              : "An empty day has no average. A mark at zero means calls averaged 0 ms."}
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <DailyPlot
            label="Daily overall"
            rows={data.daily}
            metric={metric}
            first={first}
            last={last}
            inspect={inspect}
          />
          <AgentRanking key={metric} agents={agents} metric={metric} />
          <DailyPlot
            label="Daily by agent"
            rows={selected.daily}
            metric={metric}
            first={first}
            last={last}
            inspect={inspect}
          >
            <label className="flex min-w-0 max-w-full items-center gap-2 text-[13px] text-mute">
              Agent
              <select
                className={control}
                value={selected.name}
                onChange={(event) => setAgentName(event.target.value)}
              >
                {agents.map((agent) => (
                  <option key={agent.name} value={agent.name}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
          </DailyPlot>
        </div>
      </div>
    </Section>
  );
}
