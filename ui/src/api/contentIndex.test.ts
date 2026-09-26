import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useContentIndex } from "#/api/index";

// openapi-fetch builds a Request from a relative URL, which Node's Request
// rejects; resolve it against localhost before the client captures Request.
const fetchMock = vi.hoisted(() => {
  const Native = globalThis.Request;
  globalThis.Request = class extends Native {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(
        typeof input === "string" && input.startsWith("/")
          ? `http://localhost${input}`
          : input,
        init,
      );
    }
  } as typeof Request;
  // The client captures fetch at creation too; route it through a mock.
  const mock = vi.fn<typeof fetch>();
  globalThis.fetch = ((...args: Parameters<typeof fetch>) =>
    mock(...args)) as typeof fetch;
  return mock;
});

afterEach(() => fetchMock.mockReset());

function page(total: number, title: string) {
  return new Response(
    JSON.stringify({ items: [{ path: `${title}.md`, title }], total }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("useContentIndex", () => {
  it("keeps the previous page on screen while the next page loads", async () => {
    let release: (() => void) | undefined;
    fetchMock.mockResolvedValueOnce(page(45, "first")).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(page(45, "second"));
        }),
    );
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);
    const { result, rerender } = renderHook(
      ({ offset }) => useContentIndex({ limit: 10, offset }),
      { wrapper, initialProps: { offset: 0 } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ offset: 10 });
    // Without placeholder data this is undefined, and the table says
    // "No pages match." for a round-trip.
    expect(result.current.data?.items[0]?.title).toBe("first");
    expect(result.current.isPlaceholderData).toBe(true);

    release?.();
    await waitFor(() =>
      expect(result.current.data?.items[0]?.title).toBe("second"),
    );
  });
});
