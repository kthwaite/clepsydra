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
  useAnnotations,
  useCreateAnnotation,
  useCreateWork,
  useImportBibtex,
  useImportDoi,
  useImportIsbn,
  useImportZotero,
  useUpdateWork,
  useWork,
  useWorks,
} from "#/api/academic";

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

describe("academic API hooks", () => {
  it("binds list, detail, and annotation queries to their typed routes", () => {
    const { wrapper } = harness();
    renderHook(
      () => {
        useWorks({ work_type: "paper", limit: 100 });
        useWork("work-1");
        useAnnotations("work-1");
      },
      { wrapper },
    );

    expect(mocks.query).toHaveBeenCalledWith(
      "get",
      "/api/vault/academic/works",
      { params: { query: { work_type: "paper", limit: 100 } } },
    );
    expect(mocks.query).toHaveBeenCalledWith(
      "get",
      "/api/vault/academic/works/by-id/{uuid}",
      { params: { path: { uuid: "work-1" } } },
      { enabled: true },
    );
    expect(mocks.query).toHaveBeenCalledWith(
      "get",
      "/api/vault/academic/works/by-id/{uuid}/annotations",
      { params: { path: { uuid: "work-1" } } },
      { enabled: true },
    );
  });

  it("binds every academic mutation and shares cache invalidation", () => {
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    renderHook(
      () => {
        useCreateWork();
        useUpdateWork();
        useCreateAnnotation();
        useImportBibtex();
        useImportDoi();
        useImportIsbn();
        useImportZotero();
      },
      { wrapper },
    );

    const expectedRoutes = [
      ["post", "/api/vault/academic/works"],
      ["put", "/api/vault/academic/works/by-id/{uuid}"],
      ["post", "/api/vault/academic/annotations"],
      ["post", "/api/vault/academic/import/bibtex"],
      ["post", "/api/vault/academic/import/doi"],
      ["post", "/api/vault/academic/import/isbn"],
      ["post", "/api/vault/academic/import/zotero"],
    ];

    for (const [method, route] of expectedRoutes) {
      expect(mocks.mutation).toHaveBeenCalledWith(
        method,
        route,
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );
      const call = mocks.mutation.mock.calls.find(
        ([calledMethod, calledRoute]) =>
          calledMethod === method && calledRoute === route,
      );
      const options = call?.[2] as { onSuccess: () => void };
      options.onSuccess();
    }

    expect(invalidate).toHaveBeenCalled();
  });
});
