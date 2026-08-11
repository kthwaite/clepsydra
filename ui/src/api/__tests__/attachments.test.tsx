import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachmentMarkdown,
  attachmentUrl,
  useUploadAttachment,
} from "#/api/attachments";
import { fetchClient } from "#/api/client";

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

afterEach(() => vi.restoreAllMocks());

describe("attachment helpers", () => {
  it("builds encoded retrieval URLs and image/link Markdown", () => {
    expect(attachmentUrl("research/chart 1.png")).toBe(
      "/api/vault/attachments/research/chart%201.png",
    );
    expect(
      attachmentMarkdown({
        name: "chart 1.png",
        path: "research/chart 1.png",
        size: 42,
      }),
    ).toBe("![chart 1.png](/api/vault/attachments/research/chart%201.png)");
    expect(
      attachmentMarkdown({
        name: "paper.pdf",
        path: "paper.pdf",
        size: 84,
      }),
    ).toBe("[paper.pdf](/api/vault/attachments/paper.pdf)");
  });
});

describe("useUploadAttachment", () => {
  it("sends multipart acknowledgement with the selected file", async () => {
    const post = vi.spyOn(fetchClient, "POST").mockResolvedValue({
      data: { name: "chart.png", path: "chart.png", size: 4 },
      error: undefined,
      response: new Response(null, { status: 201 }),
    } as never);
    const file = new File(["data"], "chart.png", { type: "image/png" });
    const { result } = renderHook(() => useUploadAttachment(), {
      wrapper: wrapper(),
    });

    await act(() => result.current.mutateAsync({ file }));

    expect(post).toHaveBeenCalledTimes(1);
    const [, request] = (
      post.mock.calls as unknown as Array<
        [
          string,
          {
            params?: { path?: { path?: string } };
            body?: unknown;
          },
        ]
      >
    )[0];
    expect(request?.params?.path).toEqual({ path: "chart.png" });
    expect(request?.body).toBeInstanceOf(FormData);
    expect((request?.body as unknown as FormData).get("file")).toBe(file);
    expect(
      (request?.body as unknown as FormData).get("plaintext_acknowledged"),
    ).toBe("true");
  });
});
