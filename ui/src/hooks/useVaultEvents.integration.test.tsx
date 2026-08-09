import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useVaultEvents } from "#/hooks/useVaultEvents";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  emit(notification: unknown) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(notification) }),
    );
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("invalidates the full feeds path prefix when persisted feed data changes", () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const feedKeys: readonly (readonly unknown[])[] = [
    ["get", "/api/vault/feeds"],
    [
      "get",
      "/api/vault/feeds/entries",
      { params: { query: { view: "unread" } } },
    ],
    ["get", "/api/vault/feeds/{id}", { params: { path: { id: 7 } } }],
  ];
  const unrelatedKey = ["get", "/api/vault/pages"] as const;
  for (const key of feedKeys) client.setQueryData(key, { cached: true });
  client.setQueryData(unrelatedKey, { cached: true });

  const { result } = renderHook(() => useVaultEvents(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  const stream = FakeEventSource.instances[0];
  expect(stream.url).toBe("/api/vault/events");
  act(() => stream.onopen?.(new Event("open")));
  expect(result.current).toBe("connected");

  act(() => stream.emit({ type: "feed_changed" }));

  for (const key of feedKeys) {
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  }
  expect(client.getQueryState(unrelatedKey)?.isInvalidated).toBe(false);
});
