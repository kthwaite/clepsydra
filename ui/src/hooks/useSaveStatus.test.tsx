import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useSaveStatus } from "#/hooks/useSaveStatus";

function setup() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    () => ({
      status: useSaveStatus(),
      ok: useMutation({ mutationFn: async () => "ok" }),
      bad: useMutation({
        mutationFn: async () => {
          throw new Error("nope");
        },
      }),
    }),
    { wrapper },
  );
}

describe("useSaveStatus", () => {
  it("starts idle with no save time", () => {
    const { result } = setup();
    expect(result.current.status).toEqual({ saving: false, savedAt: null });
  });

  it("records the time of a successful save", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const { result } = setup();
    await act(() => result.current.ok.mutateAsync());
    await waitFor(() => expect(result.current.status.savedAt).toBe(1_000_000));
    expect(result.current.status.saving).toBe(false);
    vi.restoreAllMocks();
  });

  it("does not claim a save when the mutation fails", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.bad.mutateAsync().catch(() => undefined);
    });
    await waitFor(() => expect(result.current.status.saving).toBe(false));
    expect(result.current.status.savedAt).toBeNull();
  });
});
