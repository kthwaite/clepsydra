import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchClient } from "#/api/client";
import { todayJournalPath } from "#/lib/journal";
import {
  useEnsureJournalToday,
  useJournalEditorOptions,
  useJournalToday,
  useQuickCapture,
} from "../journal";

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const page = {
  path: "journals/2026-08-06.md",
  canonical_name: "2026-08-06",
  revision: "rev-a",
  body: "",
  meta: { id: "019fc7fc-5ceb-7cd1-a312-e03266ff3f62", title: "2026-08-06" },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useJournalToday", () => {
  it("resolves to null when today's journal does not exist", async () => {
    vi.spyOn(fetchClient, "GET").mockResolvedValue({
      data: undefined,
      error: { error: "journal not found", status: 404 },
      response: new Response(null, { status: 404 }),
    } as never);
    const { result } = renderHook(() => useJournalToday(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it("resolves to the page when it exists", async () => {
    vi.spyOn(fetchClient, "GET").mockResolvedValue({
      data: page,
      error: undefined,
      response: new Response(null, { status: 200 }),
    } as never);
    const { result } = renderHook(() => useJournalToday(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.meta.id).toBe(page.meta.id);
  });

  it("errors on non-404 failures", async () => {
    vi.spyOn(fetchClient, "GET").mockResolvedValue({
      data: undefined,
      error: { error: "boom", status: 500 },
      response: new Response(null, { status: 500 }),
    } as never);
    const { result } = renderHook(() => useJournalToday(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useEnsureJournalToday", () => {
  it("POSTs and reports created=true on 201", async () => {
    const post = vi.spyOn(fetchClient, "POST").mockResolvedValue({
      data: page,
      error: undefined,
      response: new Response(null, { status: 201 }),
    } as never);
    const { result } = renderHook(() => useEnsureJournalToday(), {
      wrapper: wrapper(),
    });
    const out = await result.current.mutateAsync();
    expect(out.created).toBe(true);
    expect(out.page.path).toBe("journals/2026-08-06.md");
    expect(post).toHaveBeenCalledWith("/api/vault/journal/today", {});
  });

  it("reports created=false on 200", async () => {
    vi.spyOn(fetchClient, "POST").mockResolvedValue({
      data: page,
      error: undefined,
      response: new Response(null, { status: 200 }),
    } as never);
    const { result } = renderHook(() => useEnsureJournalToday(), {
      wrapper: wrapper(),
    });
    const out = await result.current.mutateAsync();
    expect(out.created).toBe(false);
  });
});

describe("useQuickCapture", () => {
  it("uses the generated capture operation with a typed body", async () => {
    const post = vi.spyOn(fetchClient, "POST").mockResolvedValue({
      data: page,
      error: undefined,
      response: new Response(null, { status: 200 }),
    } as never);
    const { result } = renderHook(() => useQuickCapture(), {
      wrapper: wrapper(),
    });

    await result.current.mutateAsync("remember this");

    expect(post).toHaveBeenCalledWith("/api/vault/journal/today/capture", {
      body: { content: "remember this" },
    });
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
