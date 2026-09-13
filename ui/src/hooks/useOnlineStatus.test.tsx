import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeOnline,
  SSE_DISCONNECT_GRACE_MS,
  useOnlineStatus,
} from "#/hooks/useOnlineStatus";
import { useConnectionStore } from "#/offline/connectionStore";

let originalOnLineDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-12T10:00:00Z"));
  originalOnLineDescriptor = Object.getOwnPropertyDescriptor(
    navigator,
    "onLine",
  );
  Object.defineProperty(navigator, "onLine", {
    value: true,
    configurable: true,
  });
  useConnectionStore.setState({ status: "connected", disconnectedSince: null });
});

afterEach(() => {
  vi.useRealTimers();
  if (originalOnLineDescriptor) {
    Object.defineProperty(navigator, "onLine", originalOnLineDescriptor);
  } else {
    // biome-ignore lint/suspicious/noExplicitAny: restoring a property jsdom may not have declared
    delete (navigator as any).onLine;
  }
});

describe("computeOnline", () => {
  const now = Date.parse("2026-09-12T10:00:00Z");
  it("is offline whenever the browser says so", () => {
    expect(
      computeOnline({
        navigatorOnline: false,
        status: "connected",
        disconnectedSince: null,
        now,
      }),
    ).toBe(false);
  });
  it("tolerates a short SSE disconnect", () => {
    expect(
      computeOnline({
        navigatorOnline: true,
        status: "disconnected",
        disconnectedSince: now - SSE_DISCONNECT_GRACE_MS + 1,
        now,
      }),
    ).toBe(true);
  });
  it("is offline once the SSE disconnect outlives the grace period", () => {
    expect(
      computeOnline({
        navigatorOnline: true,
        status: "disconnected",
        disconnectedSince: now - SSE_DISCONNECT_GRACE_MS,
        now,
      }),
    ).toBe(false);
  });
  it("treats the initial connecting state as online", () => {
    expect(
      computeOnline({
        navigatorOnline: true,
        status: "connecting",
        disconnectedSince: null,
        now,
      }),
    ).toBe(true);
  });
});

describe("useOnlineStatus", () => {
  it("flips to offline after the grace period elapses without a reconnect", () => {
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);
    act(() => {
      useConnectionStore.getState().setStatus("disconnected", Date.now());
    });
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(SSE_DISCONNECT_GRACE_MS + 1));
    expect(result.current).toBe(false);
    act(() => useConnectionStore.getState().setStatus("connected"));
    expect(result.current).toBe(true);
  });

  it("follows the browser offline/online events", () => {
    const { result } = renderHook(() => useOnlineStatus());
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
    act(() => window.dispatchEvent(new Event("offline")));
    expect(result.current).toBe(false);
    Object.defineProperty(navigator, "onLine", {
      value: true,
      configurable: true,
    });
    act(() => window.dispatchEvent(new Event("online")));
    expect(result.current).toBe(true);
  });
});
