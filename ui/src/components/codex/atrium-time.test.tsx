import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useAtriumCalendar } from "#/components/codex/atrium-time";

it("reuses day-derived values across same-day clock ticks", () => {
  const { result, rerender } = renderHook(({ now }) => useAtriumCalendar(now), {
    initialProps: { now: new Date(2026, 7, 8, 10, 0, 0) },
  });
  const morning = result.current;

  rerender({ now: new Date(2026, 7, 8, 10, 0, 1) });
  expect(result.current).toBe(morning);

  rerender({ now: new Date(2026, 7, 9, 0, 0, 0) });
  expect(result.current).not.toBe(morning);
});

it("retains a local-midnight date for day-derived display values", () => {
  const now = new Date(2026, 7, 8, 10, 30, 45);
  const { result } = renderHook(() => useAtriumCalendar(now));

  expect(result.current.date).toEqual(new Date(2026, 7, 8));
});
it("retains the actual UTC day key in positive-offset zones", () => {
  const previousTz = process.env.TZ;
  process.env.TZ = "Pacific/Kiritimati";
  try {
    const now = new Date(2026, 7, 8, 0, 30, 0);
    const { result } = renderHook(() => useAtriumCalendar(now));

    expect(result.current.date).toEqual(new Date(2026, 7, 8));
    expect(result.current.utcDate).toEqual(new Date(Date.UTC(2026, 7, 7)));
    expect(result.current.utcDate.toISOString().slice(0, 10)).toBe(
      "2026-08-07",
    );
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});
