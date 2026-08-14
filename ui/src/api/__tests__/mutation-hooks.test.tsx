import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generatedMutation: vi.fn(),
  post: vi.fn(),
}));

vi.mock("#/api/client", () => ({
  $api: {
    useMutation: mocks.generatedMutation,
    useQuery: vi.fn(),
  },
  fetchClient: { POST: mocks.post },
}));

import { useCreateFolder, useDeleteFolder, useMoveFolder } from "#/api/folders";
import { usePreviewMutation } from "#/api/index";
import { useArchivePage, useMovePage } from "#/api/pages";

function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generatedMutation.mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  });
});

describe("page and folder mutation hooks", () => {
  it("binds every operation to its backend route and structural invalidation", () => {
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    renderHook(
      () => {
        useMovePage();
        useArchivePage();
        useCreateFolder();
        useMoveFolder();
        useDeleteFolder();
      },
      { wrapper },
    );

    const expectedRoutes = [
      ["post", "/api/vault/pages-move/{path}"],
      ["delete", "/api/vault/pages/{path}"],
      ["post", "/api/vault/folders/{path}"],
      ["post", "/api/vault/folders-move/{path}"],
      ["delete", "/api/vault/folders/{path}"],
    ];
    for (const [method, route] of expectedRoutes) {
      expect(mocks.generatedMutation).toHaveBeenCalledWith(
        method,
        route,
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );
      const call = mocks.generatedMutation.mock.calls.find(
        ([calledMethod, calledRoute]) =>
          calledMethod === method && calledRoute === route,
      );
      const options = call?.[2] as { onSuccess: () => void };
      options.onSuccess();
    }

    expect(invalidate).toHaveBeenCalled();
  });

  it("parses the server mutation preview through the typed hook", async () => {
    const preview = {
      file_ops: [
        {
          kind: "rename",
          path: "notes/a.md",
          destination: "archive/a.md",
        },
      ],
      text_edits: [],
    };
    mocks.post.mockResolvedValue({ data: preview, error: undefined });
    const { wrapper } = harness();
    const { result } = renderHook(() => usePreviewMutation(), { wrapper });

    let response: unknown;
    await act(async () => {
      response = await result.current.mutateAsync({
        operation: "move_page",
        source: "notes/a.md",
        destination: "archive/a.md",
      });
    });

    expect(mocks.post).toHaveBeenCalledWith(
      "/api/vault/index/preview-mutation",
      {
        body: {
          operation: "move_page",
          source: "notes/a.md",
          destination: "archive/a.md",
        },
      },
    );
    expect(response).toEqual(preview);
  });

  it("rejects a malformed preview instead of rendering unsafe data", async () => {
    mocks.post.mockResolvedValue({
      data: {
        file_ops: [{ kind: "unknown", path: "notes/a.md" }],
        text_edits: [],
      },
      error: undefined,
    });
    const { wrapper } = harness();
    const { result } = renderHook(() => usePreviewMutation(), { wrapper });

    await expect(
      result.current.mutateAsync({
        operation: "move_page",
        source: "notes/a.md",
        destination: "notes/b.md",
      }),
    ).rejects.toThrow("invalid response");
  });
});
