import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutation: vi.fn(),
  query: vi.fn(),
}));

vi.mock("#/api/client", () => ({
  $api: {
    useMutation: mocks.mutation,
    useQuery: mocks.query,
  },
}));

import {
  useAmbiguousNames,
  useCreateFromLink,
  useIndexWarnings,
  useRebuildIndex,
  useUnresolvedLinks,
} from "#/api/index";

function harness() {
  const client = new QueryClient();
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockReturnValue({ data: undefined, isPending: false });
  mocks.mutation.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
});

describe("index health API hooks", () => {
  it("starts each diagnostic query independently", () => {
    const { wrapper } = harness();
    renderHook(
      () => {
        useUnresolvedLinks();
        useAmbiguousNames();
        useIndexWarnings();
      },
      { wrapper },
    );

    expect(mocks.query).toHaveBeenCalledWith(
      "get",
      "/api/vault/index/unresolved",
      {},
      { throwOnError: false },
    );
    expect(mocks.query).toHaveBeenCalledWith(
      "get",
      "/api/vault/index/ambiguous",
      {},
      { throwOnError: false },
    );
    expect(mocks.query).toHaveBeenCalledWith(
      "get",
      "/api/vault/index/warnings",
      {},
      { throwOnError: false },
    );
  });

  it("binds atomic create and rebuild mutations with shared invalidation", () => {
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const academicKey = ["get", "/api/vault/academic/works"] as const;
    client.setQueryData(academicKey, { items: [], total: 0 });
    renderHook(
      () => {
        useCreateFromLink();
        useRebuildIndex();
      },
      { wrapper },
    );

    for (const route of [
      "/api/vault/index/create-from-link",
      "/api/vault/index/rebuild",
    ]) {
      expect(mocks.mutation).toHaveBeenCalledWith(
        "post",
        route,
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );
      const call = mocks.mutation.mock.calls.find(
        ([method, calledRoute]) => method === "post" && calledRoute === route,
      );
      const options = call?.[2] as { onSuccess: () => void };
      options.onSuccess();
    }

    expect(invalidate).toHaveBeenCalled();
    expect(client.getQueryState(academicKey)?.isInvalidated).toBe(true);
  });
});
