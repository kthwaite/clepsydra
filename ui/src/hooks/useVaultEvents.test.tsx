import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "#/api/keys";
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
  it("invalidates academic and task telemetry queries when the index changes", () => {
    const client = new QueryClient();
    const academicKey = ["get", "/api/vault/academic/works"] as const;
    const taskHistoryKey = queryKeys.tasks.history(undefined);
    const burndownKey = queryKeys.agenda.cycleBurndown("C-01");
    client.setQueryData(academicKey, { items: [], total: 0 });
    client.setQueryData(taskHistoryKey, { days: [] });
    client.setQueryData(burndownKey, { cycle: "C-01", points: [] });

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
    expect(client.getQueryState(taskHistoryKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(burndownKey)?.isInvalidated).toBe(true);
    unmount();
  });

  it("invalidates the board query on index_changed", async () => {
    const client = new QueryClient();
    const boardKey = queryKeys.board.all;
    client.setQueryData(boardKey, {});

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

    expect(client.getQueryState(boardKey)?.isInvalidated).toBe(true);
    unmount();
  });
});
