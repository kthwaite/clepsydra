import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClock } from "./useClock";

describe("useClock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T18:17:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("returns the current date and advances each second", () => {
    const { result } = renderHook(() => useClock());
    const first = result.current.getTime();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.getTime()).toBe(first + 1000);
  });
});
