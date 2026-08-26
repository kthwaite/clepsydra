import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGeocode, useUpdateLocation } from "#/api/location";

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

function freshClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

describe("useUpdateLocation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("PUTs the location body and parses the response", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ latitude: 51.5, longitude: -0.12, label: "London" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    const qc = freshClient();
    const { result } = renderHook(() => useUpdateLocation(), {
      wrapper: wrapper(qc),
    });

    result.current.mutate({
      latitude: 51.5,
      longitude: -0.12,
      label: "London",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/vault/location");
    expect(init).toBeDefined();
    const requestInit = init as RequestInit;
    expect(requestInit.method).toBe("PUT");
    expect(
      (requestInit.headers as Record<string, string>)["Content-Type"],
    ).toBe("application/json");
    expect(JSON.parse(requestInit.body as string)).toEqual({
      latitude: 51.5,
      longitude: -0.12,
      label: "London",
    });
    expect(result.current.data).toEqual({
      latitude: 51.5,
      longitude: -0.12,
      label: "London",
    });
  });

  it("invalidates the location query on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ latitude: 1, longitude: 2, label: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const qc = freshClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useUpdateLocation(), {
      wrapper: wrapper(qc),
    });

    result.current.mutate({ latitude: 1, longitude: 2, label: null });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["location"] });
  });

  it("throws when the response is not ok", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad", { status: 400 }),
    );
    const qc = freshClient();
    const { result } = renderHook(() => useUpdateLocation(), {
      wrapper: wrapper(qc),
    });

    result.current.mutate({ latitude: 999, longitude: 2, label: null });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useGeocode", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GETs the geocode endpoint and returns parsed candidates", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { label: "Paris, France", latitude: 48.85, longitude: 2.35 },
            { label: "Paris, Texas", latitude: 33.66, longitude: -95.55 },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const qc = freshClient();
    const { result } = renderHook(() => useGeocode(), { wrapper: wrapper(qc) });

    result.current.mutate("Paris");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/vault/geocode?q=Paris");
    expect(init?.method ?? "GET").toBe("GET");
    expect(result.current.data).toEqual([
      { label: "Paris, France", latitude: 48.85, longitude: 2.35 },
      { label: "Paris, Texas", latitude: 33.66, longitude: -95.55 },
    ]);
  });

  it("encodes the query string", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const qc = freshClient();
    const { result } = renderHook(() => useGeocode(), { wrapper: wrapper(qc) });

    result.current.mutate("New York");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // URLSearchParams form-encodes spaces as "+" (valid for query strings).
    expect(String(fetchMock.mock.calls[0][0])).toContain("q=New+York");
  });
});
