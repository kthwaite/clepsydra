import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useAtriumCalendar } from "#/components/codex/atrium-time";

it("reuses day-derived values across same-day clock ticks", () => {
  const { result, rerender } = renderHook(
    ({ now }) => useAtriumCalendar(now),
    { initialProps: { now: new Date(2026, 7, 8, 10, 0, 0) } },
  );
  const morning = result.current;

  rerender({ now: new Date(2026, 7, 8, 10, 0, 1) });
  expect(result.current).toBe(morning);

  rerender({ now: new Date(2026, 7, 9, 0, 0, 0) });
  expect(result.current).not.toBe(morning);
});
