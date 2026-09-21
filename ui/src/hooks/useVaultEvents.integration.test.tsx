import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { Middleware } from "openapi-fetch";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLiveBaseRender } from "#/api/bases";
import { fetchClient } from "#/api/client";
import type { paths } from "#/api/schema";
import { useVaultEvents } from "#/hooks/useVaultEvents";

vi.mock("#/api/client", async () => {
  // Vitest hoists this module factory before static runtime imports initialize.
  const { default: createFetchClient } = await import("openapi-fetch");
  const { default: createClient } = await import("openapi-react-query");
  const fetchClient = createFetchClient<paths>({ baseUrl: "http://localhost" });
  return { fetchClient, $api: createClient(fetchClient) };
});

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
  const rubbishKeys: readonly (readonly unknown[])[] = [
    ["get", "/api/vault/rubbish"],
    [
      "get",
      "/api/vault/rubbish/{item_id}",
      { params: { path: { item_id: "item-1" } } },
    ],
  ];
  const unrelatedKey = ["get", "/api/vault/pages"] as const;
  for (const key of feedKeys) client.setQueryData(key, { cached: true });
  client.setQueryData(unrelatedKey, { cached: true });
  for (const key of rubbishKeys) client.setQueryData(key, { cached: true });

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
  for (const key of rubbishKeys) {
    expect(client.getQueryState(key)?.isInvalidated).toBe(false);
  }
});

it("refreshes live Markdown after record edits and Base selection changes", async () => {
  let markdown = "Original live report";
  const transport: Middleware = {
    onRequest({ request }) {
      if (request.url.includes("/base-render/render")) {
        return Response.json({ markdown, selected_count: 1 });
      }
    },
  };
  fetchClient.use(transport);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  try {
    const { result } = renderHook(
      () => {
        useVaultEvents();
        return useLiveBaseRender(
          { base: "tastings", template: "notes" },
          "reports/tastings.md",
        );
      },
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    await waitFor(() =>
      expect(result.current.data?.markdown).toBe("Original live report"),
    );
    const stream = FakeEventSource.instances[0];
    markdown = "Report after a source edit";
    act(() =>
      stream.emit({
        type: "index_changed",
        upserted: ["tastings/source.md"],
        removed: [],
      }),
    );
    await waitFor(() =>
      expect(result.current.data?.markdown).toBe("Report after a source edit"),
    );
    markdown = "Report after changed Base membership";
    act(() => stream.emit({ type: "base_registry_changed" }));
    await waitFor(() =>
      expect(result.current.data?.markdown).toBe(
        "Report after changed Base membership",
      ),
    );
  } finally {
    fetchClient.eject(transport);
    client.clear();
  }
});
