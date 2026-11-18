import { describe, expect, it } from "vitest";
import { agentSeries } from "#/components/codex/mcpAgentSeries";

function row(
  date: string,
  name: string,
  calls: number,
  average_duration_ms: number,
) {
  return { date, name, calls, average_duration_ms };
}

describe("agentSeries", () => {
  it("keeps simultaneous callers distinct, even with reserved names or Recharts path syntax", () => {
    const labels = ["day", "__proto__", "agent[0].name", "agent.0.name"];
    const rows = labels.map((name, i) => row("1970-01-02", name, i + 1, 0));
    const { agents, points } = agentSeries(rows, 0, 2, "calls");
    expect(points.map((point) => point.day)).toEqual([0, 1, 2]);
    expect(agents.map((agent) => agent.name).sort()).toEqual(
      [...labels].sort(),
    );
    for (const { name, key } of agents) {
      expect(key).toMatch(/^\w+$/);
      expect(points[1][key]).toBe(labels.indexOf(name) + 1);
      expect(points[0][key] ?? 0).toBe(0);
    }
  });

  it("keeps observed zero milliseconds distinct from missing duration across a clock change", () => {
    const first = Date.UTC(2026, 2, 7) / 86_400_000;
    const { agents, points } = agentSeries(
      [
        row("2026-03-09", "editor", 2, 1.5),
        row("2026-03-07", "editor", 1, 0),
        row("2026-03-08", "browser", 3, 10),
        row("2026-03-06", "out of scope", 9, 100),
      ],
      first,
      first + 2,
      "average_duration_ms",
    );
    expect(agents.map(({ name }) => name)).toEqual(["browser", "editor"]);
    expect(points.map(({ day }) => day)).toEqual([first, first + 1, first + 2]);
    expect(points.map((p) => p[agents[0].key])).toEqual([
      undefined,
      10,
      undefined,
    ]);
    expect(points.map((p) => p[agents[1].key])).toEqual([0, undefined, 1.5]);
  });

  it("breaks lines across inactive years without allocating a point per day", () => {
    const last = Date.UTC(2099, 0, 2) / 86_400_000;
    const { agents, points } = agentSeries(
      [row("2099-01-01", "A", 2, 4), row("1970-01-02", "A", 1, 3)],
      0,
      last,
      "average_duration_ms",
    );
    const key = agents[0].key;
    expect(points.at(0)?.day).toBe(0);
    expect(points.at(-1)?.day).toBe(last);
    expect(points.length).toBeLessThan(10);
    const observed = points.filter((p) => p[key] !== undefined);
    expect(observed.map((p) => p.day)).toEqual([1, last - 1]);
    const gap = points.find((p) => p.day > 1 && p.day < last - 1);
    expect(gap).toBeDefined();
    expect(gap?.[key]).toBeUndefined();
  });
});
