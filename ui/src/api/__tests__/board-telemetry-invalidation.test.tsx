import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCreateTask, usePatchCycle, usePatchTask } from "#/api/board";
import { queryKeys } from "#/api/keys";
import { BOARD_FIXTURE } from "#/components/tasking/__tests__/fixtures";

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function seedTelemetry(client: QueryClient) {
  const historyKey = queryKeys.tasks.history(undefined);
  const burndownKey = queryKeys.agenda.cycleBurndown("C-01");
  client.setQueryData(historyKey, { days: [] });
  client.setQueryData(burndownKey, { cycle: "C-01", points: [] });
  return { historyKey, burndownKey };
}

describe("board telemetry invalidation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refreshes task and cycle history after task and cycle mutations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const data = url.includes("/cycles/")
          ? BOARD_FIXTURE.cycles[0]
          : BOARD_FIXTURE.tasks[0];
        return Promise.resolve(
          new Response(JSON.stringify(data), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }),
    );
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    client.setQueryData(queryKeys.board.all, BOARD_FIXTURE);
    const { result } = renderHook(
      () => ({
        createTask: useCreateTask(),
        patchTask: usePatchTask(),
        patchCycle: usePatchCycle(),
      }),
      { wrapper: wrapper(client) },
    );

    for (const mutate of [
      () => result.current.createTask.mutateAsync({ title: "New task" }),
      () =>
        result.current.patchTask.mutateAsync({
          id: BOARD_FIXTURE.tasks[0].id,
          patch: { status: "SEALED" },
        }),
      () =>
        result.current.patchCycle.mutateAsync({
          id: BOARD_FIXTURE.cycles[0].id,
          patch: { state: "CLOSED", carry_to: "BACKLOG" },
        }),
    ]) {
      const { historyKey, burndownKey } = seedTelemetry(client);
      await act(async () => {
        await mutate();
      });
      expect(client.getQueryState(historyKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(burndownKey)?.isInvalidated).toBe(true);
    }
  });
});
