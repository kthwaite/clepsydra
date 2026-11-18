import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { formatApiError } from "#/api/error";
import {
  type McpStatsDays,
  type McpStatsResponse,
  useMcpStats,
} from "#/api/mcp";
import { McpTrends } from "#/components/codex/McpTrends";
import { Section } from "#/components/codex/Section";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

const timestamp = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});
const count = (value: number) => value.toLocaleString();
const duration = (value: number) =>
  `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms`;
const cell = "px-3 py-3 align-top";
const numericCell = `${cell} text-right tabular-nums whitespace-nowrap`;

function RecordedTime({ value }: { value: string | null | undefined }) {
  return value ? (
    <time
      dateTime={value}
      title={value}
      className="whitespace-nowrap text-mute"
    >
      {timestamp.format(new Date(value))}
    </time>
  ) : (
    <span className="text-mute">—</span>
  );
}

function StatsTable({
  label,
  columns,
  children,
  className,
}: {
  label: string;
  columns: readonly string[];
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={`${label} table, scroll for more`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: A labelled overflow region needs keyboard focus for scrolling.
      tabIndex={0}
      className={cn(
        "max-h-[32rem] overflow-auto rounded-xl bg-raise",
        FOCUS_RING_NATIVE,
        className,
      )}
    >
      <table
        aria-label={label}
        className="w-full text-left text-[13px] text-ink-2"
      >
        <thead className="sticky top-0 bg-sink text-mute">
          <tr>
            {columns.map((column, index) => (
              <th
                key={column}
                scope="col"
                className={cn(
                  "px-3 py-2.5 font-medium whitespace-nowrap",
                  index > 0 && "text-right",
                )}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&_tr:nth-child(even)]:bg-ground/40">
          {children}
        </tbody>
      </table>
    </section>
  );
}

function Summary({ data }: { data: McpStatsResponse }) {
  const metrics = [
    { label: "Calls", value: count(data.total_calls) },
    { label: "Successful", value: count(data.successful_calls) },
    { label: "Failed or cancelled", value: count(data.failed_calls) },
    { label: "Sessions", value: count(data.sessions) },
    { label: "Agent labels", value: count(data.agents) },
    { label: "Pages referenced", value: count(data.pages) },
    {
      label: "Average duration",
      value: data.total_calls ? duration(data.average_duration_ms) : "—",
    },
  ];
  return (
    <Section label="At a glance">
      <dl className="m-0 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {metrics.map(({ label, value }) => (
          <div
            key={label}
            className="flex min-w-0 flex-col gap-2 rounded-xl bg-raise px-4 py-3.5"
          >
            <dt className="text-[13px] text-mute">{label}</dt>
            <dd className="m-0 text-[26px] leading-tight tabular-nums text-ink">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function ToolUsage({ tools }: { tools: McpStatsResponse["tools"] }) {
  return (
    <Section
      label="Tool usage"
      caption="Registered tools include those unused in this range. Access is a tool hint, not proof a write occurred."
      wrapHeader
    >
      {tools.length === 0 ? (
        <p className="m-0 text-[14px] text-mute">
          No tool catalog recorded yet.
        </p>
      ) : (
        <StatsTable
          label="Tool usage"
          columns={[
            "Tool",
            "Access",
            "Calls",
            "Failures",
            "Average",
            "Last used · UTC",
          ]}
        >
          {tools.map((tool) => (
            <tr key={tool.name}>
              <th scope="row" className={cn(cell, "font-normal")}>
                <span className="break-all text-ink">{tool.name}</span>
                {tool.calls === 0 ? (
                  <span className="mt-1 block text-[12px] text-mute">
                    Unused in this range
                  </span>
                ) : null}
              </th>
              <td className={numericCell}>
                {tool.read_only ? "Read-only" : "May write"}
              </td>
              <td className={numericCell}>{count(tool.calls)}</td>
              <td className={numericCell}>{count(tool.failures)}</td>
              <td className={numericCell}>
                {tool.calls ? duration(tool.average_duration_ms) : "—"}
              </td>
              <td className={numericCell}>
                <RecordedTime value={tool.last_used_at} />
              </td>
            </tr>
          ))}
        </StatsTable>
      )}
    </Section>
  );
}

function AgentUsage({ clients }: { clients: McpStatsResponse["clients"] }) {
  return (
    <Section label="Agents and clients" caption="Ranked by calls" wrapHeader>
      <p className="mt-0 mb-4 max-w-3xl text-[13px] leading-relaxed text-mute">
        Identity is self-reported by the MCP client, not verified model
        identity. An explicit CLEP_MCP_AGENT label takes precedence over the
        client name. Rows distinguish client versions; agent totals count
        distinct labels.
      </p>
      {clients.length === 0 ? (
        <p className="m-0 text-[14px] text-mute">
          No clients with calls in this range.
        </p>
      ) : (
        <StatsTable
          label="Agents and clients"
          columns={[
            "Agent / client",
            "Calls",
            "Failures",
            "Sessions",
            "Average",
            "Last used · UTC",
          ]}
        >
          {clients.map((client) => (
            <tr
              key={JSON.stringify([
                client.name,
                client.client_name,
                client.client_version,
              ])}
            >
              <th scope="row" className={cn(cell, "font-normal")}>
                <span className="break-words text-ink">{client.name}</span>
                <span className="mt-1 block text-[12px] text-mute">
                  {client.client_name}
                  {client.client_version
                    ? ` · ${client.client_version}`
                    : " · version not reported"}
                </span>
              </th>
              <td className={numericCell}>{count(client.calls)}</td>
              <td className={numericCell}>{count(client.failures)}</td>
              <td className={numericCell}>{count(client.sessions)}</td>
              <td className={numericCell}>
                {duration(client.average_duration_ms)}
              </td>
              <td className={numericCell}>
                <RecordedTime value={client.last_used_at} />
              </td>
            </tr>
          ))}
        </StatsTable>
      )}
    </Section>
  );
}

function PageActivity({ pages }: { pages: McpStatsResponse["page_activity"] }) {
  return (
    <Section
      label="Page activity"
      caption="Top 50 pages by distinct calls"
      wrapHeader
    >
      <p className="mt-0 mb-4 max-w-3xl text-[13px] leading-relaxed text-mute">
        Target means explicitly addressed, not proof of successful access.
        Result means page metadata was returned. A call can count in both
        columns, but only once in Calls. Missing pages retain their recorded
        reference without a link. Large calls retain at most 1,000 references
        within a 512 KiB metadata budget, so page counts can be partial.
      </p>
      {pages.length === 0 ? (
        <p className="m-0 text-[14px] text-mute">
          No page references in this range.
        </p>
      ) : (
        <StatsTable
          label="Page activity"
          columns={["Page", "Calls", "Target", "Result", "Last used · UTC"]}
        >
          {pages.map((page) => (
            <tr key={page.page_id ?? page.path}>
              <th scope="row" className={cn(cell, "font-normal")}>
                {page.title !== null &&
                page.title !== undefined &&
                page.path ? (
                  <Link
                    to="/pages/$"
                    params={{ _splat: page.path }}
                    className={cn(
                      "rounded-sm text-accent underline-offset-4 hover:underline",
                      FOCUS_RING_NATIVE,
                    )}
                  >
                    {page.title || page.path}
                  </Link>
                ) : (
                  <span className="break-all">
                    {page.path ?? page.page_id ?? "Unknown page"}
                    <span className="mt-1 block text-[12px] text-mute">
                      Not currently indexed
                    </span>
                  </span>
                )}
              </th>
              <td className={numericCell}>{count(page.calls)}</td>
              <td className={numericCell}>{count(page.target_calls)}</td>
              <td className={numericCell}>{count(page.result_calls)}</td>
              <td className={numericCell}>
                <RecordedTime value={page.last_used_at} />
              </td>
            </tr>
          ))}
        </StatsTable>
      )}
    </Section>
  );
}

function DailyActivity({ daily }: { daily: McpStatsResponse["daily"] }) {
  const maximum = daily.reduce((max, day) => Math.max(max, day.calls), 1);
  return (
    <Section
      label="Daily activity"
      caption="UTC dates · days without calls are omitted"
      wrapHeader
    >
      {daily.length === 0 ? (
        <p className="m-0 text-[14px] text-mute">
          No daily activity in this range.
        </p>
      ) : (
        <StatsTable
          label="Daily activity"
          columns={["Date · UTC", "Calls", "Failures"]}
          className="max-h-80"
        >
          {daily.map((day) => (
            <tr key={day.date}>
              <th
                scope="row"
                className={cn(cell, "font-normal whitespace-nowrap")}
              >
                <time dateTime={day.date}>{day.date}</time>
              </th>
              <td className={numericCell}>
                <div className="flex items-center justify-end gap-3">
                  <span
                    aria-hidden="true"
                    className="hidden h-1.5 w-32 overflow-hidden rounded-full bg-sink sm:block"
                  >
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{ width: `${(day.calls / maximum) * 100}%` }}
                    />
                  </span>
                  {count(day.calls)}
                </div>
              </td>
              <td className={numericCell}>{count(day.failures)}</td>
            </tr>
          ))}
        </StatsTable>
      )}
    </Section>
  );
}

function outcomeLabel(outcome: string) {
  switch (outcome) {
    case "success":
      return "Success";
    case "tool_error":
      return "Tool error";
    case "protocol_error":
      return "Protocol error";
    case "cancelled":
      return "Cancelled";
    default:
      return outcome;
  }
}

function RecentCalls({ calls }: { calls: McpStatsResponse["recent_calls"] }) {
  return (
    <Section
      label="Recent calls"
      caption="Latest 50 in this range · timestamps in UTC"
      wrapHeader
    >
      {calls.length === 0 ? (
        <p className="m-0 text-[14px] text-mute">
          No recent calls in this range.
        </p>
      ) : (
        <StatsTable
          label="Recent calls"
          columns={[
            "Tool / time",
            "Agent / client",
            "Outcome",
            "Duration",
            "Page references",
          ]}
        >
          {calls.map((call) => (
            <tr key={call.call_id}>
              <th scope="row" className={cn(cell, "font-normal")}>
                <span className="break-all text-ink">{call.tool}</span>
                <span className="mt-1 block text-[12px]">
                  <RecordedTime value={call.started_at} />
                </span>
              </th>
              <td className={cn(cell, "text-right")}>
                {call.agent_label ?? call.client_name}
              </td>
              <td
                className={cn(
                  cell,
                  "text-right",
                  call.outcome !== "success" && "text-hot",
                )}
              >
                {outcomeLabel(call.outcome)}
                {call.error_code !== null && call.error_code !== undefined ? (
                  <span className="mt-1 block text-[12px]">
                    Code {call.error_code}
                  </span>
                ) : null}
              </td>
              <td className={numericCell}>{duration(call.duration_ms)}</td>
              <td className={cn(cell, "text-right")}>
                {call.pages.length === 0 ? (
                  <span className="text-mute">None recorded</span>
                ) : (
                  <details>
                    <summary
                      className={cn(
                        "cursor-pointer rounded-sm whitespace-nowrap text-mute",
                        FOCUS_RING_NATIVE,
                      )}
                    >
                      {count(
                        call.pages.filter((page) => page.source === "target")
                          .length,
                      )}{" "}
                      target ·{" "}
                      {count(
                        call.pages.filter((page) => page.source === "result")
                          .length,
                      )}{" "}
                      result
                    </summary>
                    <ul className="m-0 mt-2 min-w-48 list-none space-y-2 p-0 text-left text-[12px]">
                      {call.pages.map((page) => (
                        <li
                          key={JSON.stringify([
                            page.page_id,
                            page.path,
                            page.source,
                          ])}
                          className="break-all"
                        >
                          {page.path ?? page.page_id}{" "}
                          <span className="text-mute">({page.source})</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </td>
            </tr>
          ))}
        </StatsTable>
      )}
    </Section>
  );
}

export function McpStats() {
  const [days, setDays] = useState<McpStatsDays>(30);
  const rangeId = useId();
  const { data, error, isPending, isFetching, refetch } = useMcpStats(days);
  return (
    <div className="flex min-w-0 flex-col gap-9">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-3xl text-[13px] leading-relaxed text-mute">
          <p className="m-0">
            Local MCP tool calls, recorded from connected clients. Only call
            metadata and page references are stored, never full arguments or
            result bodies. Counts cover recorded activity, not activity before
            tracking began.
          </p>
          {data ? (
            <p className="mt-2 mb-0">
              {data.tracking_since ? (
                <>
                  Tracking since <RecordedTime value={data.tracking_since} />{" "}
                  UTC.
                </>
              ) : (
                "Tracking has not started yet."
              )}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={rangeId} className="text-[13px] text-mute">
              Date range
            </label>
            <select
              id={rangeId}
              value={days}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (value === 7 || value === 30 || value === 90 || value === 0)
                  setDays(value);
              }}
              className={cn(
                "h-9 rounded-xl bg-sink px-3 text-[14px] text-ink",
                FOCUS_RING_NATIVE,
              )}
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={0}>All time</option>
            </select>
          </div>
          <Button
            aria-label="Refresh MCP statistics"
            onPress={() => void refetch()}
            isDisabled={isFetching}
          >
            <RefreshCw
              aria-hidden="true"
              className={cn(
                "h-4 w-4",
                isFetching && "motion-safe:animate-spin",
              )}
            />
            Refresh
          </Button>
        </div>
      </div>
      {isPending ? (
        <p role="status" className="m-0 text-[14px] text-mute">
          Loading MCP statistics…
        </p>
      ) : null}
      {isFetching && data ? (
        <p role="status" className="m-0 text-[13px] text-mute">
          Refreshing MCP statistics…
        </p>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="rounded-xl bg-raise p-4 text-[14px] text-hot"
        >
          {formatApiError(error, "Could not load MCP statistics.")}
          {data
            ? " Showing the last loaded counts; refresh to try again."
            : " Use Refresh to try again."}
        </div>
      ) : null}
      {data ? (
        <>
          {data.total_calls === 0 ? (
            <p className="m-0 rounded-xl bg-raise p-4 text-[14px] text-mute">
              No MCP calls in this range.
            </p>
          ) : null}
          <Summary data={data} />
        </>
      ) : null}
      <McpTrends data={data} />
      {data ? (
        <>
          <ToolUsage tools={data.tools} />
          <AgentUsage clients={data.clients} />
          <PageActivity pages={data.page_activity} />
          <DailyActivity daily={data.daily} />
          <RecentCalls calls={data.recent_calls} />
        </>
      ) : null}
    </div>
  );
}
