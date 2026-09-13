import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextBackoffMs, useVaultEvents } from "#/hooks/useVaultEvents";
import { useConnectionStore } from "#/offline/connectionStore";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn();
  constructor(_url: string | URL) {
    FakeEventSource.instances.push(this);
  }
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  Object.defineProperty(navigator, "onLine", {
    value: true,
    configurable: true,
  });
  useConnectionStore.setState({
    status: "connecting",
    disconnectedSince: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("nextBackoffMs", () => {
  it("doubles from 3s to a 60s cap with ±20% jitter", () => {
    const noJitter = () => 0.5;
    expect(nextBackoffMs(0, noJitter)).toBe(3000);
    expect(nextBackoffMs(1, noJitter)).toBe(6000);
    expect(nextBackoffMs(2, noJitter)).toBe(12000);
    expect(nextBackoffMs(10, noJitter)).toBe(60000);
    expect(nextBackoffMs(0, () => 0)).toBe(2400);
    expect(nextBackoffMs(0, () => 1)).toBe(3600);
  });
});

describe("useVaultEvents reconnect", () => {
  it("backs off between reconnect attempts and resets after a successful open", () => {
    const { unmount } = renderHook(() => useVaultEvents(), { wrapper });
    expect(FakeEventSource.instances).toHaveLength(1);

    act(() => FakeEventSource.instances[0]?.onerror?.(new Event("error")));
    act(() => vi.advanceTimersByTime(2399));
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(3601 - 2399));
    expect(FakeEventSource.instances).toHaveLength(2);

    act(() => FakeEventSource.instances[1]?.onerror?.(new Event("error")));
    act(() => vi.advanceTimersByTime(4799));
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(7201 - 4799));
    expect(FakeEventSource.instances).toHaveLength(3);

    act(() => FakeEventSource.instances[2]?.onopen?.(new Event("open")));
    act(() => FakeEventSource.instances[2]?.onerror?.(new Event("error")));
    act(() => vi.advanceTimersByTime(3601));
    expect(FakeEventSource.instances).toHaveLength(4);
    unmount();
  });

  it("writes status and disconnectedSince into the connection store", () => {
    vi.setSystemTime(new Date("2026-09-12T10:00:00Z"));
    const { unmount } = renderHook(() => useVaultEvents(), { wrapper });
    expect(useConnectionStore.getState().status).toBe("connecting");
    act(() => FakeEventSource.instances[0]?.onopen?.(new Event("open")));
    expect(useConnectionStore.getState()).toMatchObject({
      status: "connected",
      disconnectedSince: null,
    });
    act(() => FakeEventSource.instances[0]?.onerror?.(new Event("error")));
    expect(useConnectionStore.getState()).toMatchObject({
      status: "disconnected",
      disconnectedSince: Date.parse("2026-09-12T10:00:00Z"),
    });
    unmount();
  });

  it("does not reconnect while the browser is offline and reconnects on the online event", () => {
    const { unmount } = renderHook(() => useVaultEvents(), { wrapper });
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
    act(() => FakeEventSource.instances[0]?.onerror?.(new Event("error")));
    act(() => vi.advanceTimersByTime(120_000));
    expect(FakeEventSource.instances).toHaveLength(1);

    Object.defineProperty(navigator, "onLine", {
      value: true,
      configurable: true,
    });
    act(() => window.dispatchEvent(new Event("online")));
    expect(FakeEventSource.instances).toHaveLength(2);
    unmount();
  });
});
