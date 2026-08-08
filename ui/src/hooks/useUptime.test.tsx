import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useUptime } from "#/hooks/useUptime";

const { uptimeData } = vi.hoisted(() => ({
  uptimeData: { uptime_seconds: 120 },
}));

vi.mock("#/api/client", () => ({
  $api: {
    useQuery: () => ({ data: uptimeData }),
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-08T12:00:00Z"));
});

afterEach(() => vi.useRealTimers());

it("re-renders only when the displayed uptime minute changes", () => {
  function Consumer() {
    const renders = useRef(0);
    renders.current += 1;
    return <output>{`${useUptime()}:${renders.current}`}</output>;
  }

  render(<Consumer />);
  const initialRenders = Number(screen.getByText(/0h 02m:/).textContent?.split(":")[1]);

  for (let second = 0; second < 59; second += 1) {
    act(() => vi.advanceTimersByTime(1000));
  }
  expect(screen.getByText(`0h 02m:${initialRenders}`)).toBeInTheDocument();

  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByText(`0h 03m:${initialRenders + 1}`)).toBeInTheDocument();
});
