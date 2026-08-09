import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useVaultEvents } from "#/hooks/useVaultEvents";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {}
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("useVaultEvents", () => {
  it("invalidates academic queries when the index changes", () => {
    const client = new QueryClient();
    const academicKey = ["get", "/api/vault/academic/works"] as const;
    client.setQueryData(academicKey, { items: [], total: 0 });

    const { unmount } = renderHook(() => useVaultEvents(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    const source = FakeEventSource.instances[0];

    act(() => {
      source?.onmessage?.({
        data: JSON.stringify({
          type: "index_changed",
          upserted: ["*"],
          removed: [],
        }),
      } as MessageEvent<string>);
    });

    expect(client.getQueryState(academicKey)?.isInvalidated).toBe(true);
    unmount();
  });
});
