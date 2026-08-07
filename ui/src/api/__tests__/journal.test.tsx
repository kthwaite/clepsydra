import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { todayJournalPath } from "#/lib/journal";
import {
  useEnsureJournalToday,
  useJournalEditorOptions,
  useJournalToday,
} from "../journal";

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const page = {
  path: "journals/2026-08-06.md",
  canonical_name: "2026-08-06",
  revision: "rev-a",
  body: "",
  meta: { id: "019fc7fc-5ceb-7cd1-a312-e03266ff3f62", title: "2026-08-06" },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useJournalToday", () => {
  it("resolves to null when today's journal does not exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse(404, { error: "journal not found" })),
    );
    const { result } = renderHook(() => useJournalToday(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it("resolves to the page when it exists", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, page)));
    const { result } = renderHook(() => useJournalToday(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.meta.id).toBe(page.meta.id);
  });

  it("errors on non-404 failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" })),
    );
    const { result } = renderHook(() => useJournalToday(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useEnsureJournalToday", () => {
  it("POSTs and reports created=true on 201", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, page));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useEnsureJournalToday(), {
      wrapper: wrapper(),
    });
    const out = await result.current.mutateAsync();
    expect(out.created).toBe(true);
    expect(out.page.path).toBe("journals/2026-08-06.md");
    expect(fetchMock).toHaveBeenCalledWith("/api/vault/journal/today", {
      method: "POST",
    });
  });

  it("reports created=false on 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, page)));
    const { result } = renderHook(() => useEnsureJournalToday(), {
      wrapper: wrapper(),
    });
    const out = await result.current.mutateAsync();
    expect(out.created).toBe(false);
  });
});

describe("useJournalEditorOptions", () => {
  it("returns an ensure option for today's journal path", () => {
    const { result } = renderHook(
      () => useJournalEditorOptions(todayJournalPath()),
      { wrapper: wrapper() },
    );
    expect(result.current?.ensure).toBeTypeOf("function");
  });

  it("returns undefined for any other path", () => {
    const { result } = renderHook(
      () => useJournalEditorOptions("journals/1999-01-01.md"),
      { wrapper: wrapper() },
    );
    expect(result.current).toBeUndefined();
  });

  it("is referentially stable across rerenders", () => {
    const { result, rerender } = renderHook(
      () => useJournalEditorOptions(todayJournalPath()),
      { wrapper: wrapper() },
    );
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
