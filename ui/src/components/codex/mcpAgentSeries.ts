import type { McpStatsResponse } from "#/api/mcp";

export type AgentMetric = "calls" | "average_duration_ms";
type Point = { day: number; [key: string]: number | undefined };

export function agentSeries(
  rows: McpStatsResponse["daily_agents"],
  first: number,
  last: number,
  metric: AgentMetric,
) {
  const keys = new Map<string, string>();
  const byDay = new Map<number, Point>();
  for (const row of rows) {
    const day = Date.parse(`${row.date}T00:00:00Z`) / 86_400_000;
    if (day < first || day > last) continue;
    let key = keys.get(row.name);
    if (key === undefined) {
      // Recharts interprets dots and brackets in data keys as property paths.
      key = `s${keys.size}`;
      keys.set(row.name, key);
    }
    let point = byDay.get(day);
    if (!point) {
      point = { day };
      byDay.set(day, point);
    }
    point[key] = row[metric];
  }

  const agents = [...keys]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, key]) => ({ name, key }));
  const points: Point[] = [];
  if (last - first <= 90) {
    // Rolling windows may include partial days at both ends.
    for (let day = first; day <= last; day++) {
      points.push(byDay.get(day) ?? { day });
    }
  } else {
    // The numeric axis preserves elapsed time. One empty point breaks every
    // agent's line across a gap, however long the vault has been tracking.
    const days = new Set([first, last, ...byDay.keys()]);
    let previous = first;
    for (const day of [...days].sort((a, b) => a - b)) {
      if (day > previous + 1) points.push({ day: previous + 1 });
      points.push(byDay.get(day) ?? { day });
      previous = day;
    }
  }
  return { agents, points };
}
