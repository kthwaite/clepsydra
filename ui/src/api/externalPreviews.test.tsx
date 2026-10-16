import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchClient } from "#/api/client";
import {
  type ExternalPreview,
  externalPreviewImageUrl,
  externalPreviewUrl,
  useExternalPreview,
} from "#/api/externalPreviews";

const captured: ExternalPreview = {
  state: "ready",
  title: "Example page",
  description: "A useful description",
  final_url: "https://example.com/",
  image_url: "/api/vault/external-previews/images/abc123",
  captured_at: "2026-10-16T12:00:00Z",
  refreshing: false,
};

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

afterEach(() => vi.restoreAllMocks());

describe("external preview requests", () => {
  it("checks server opt-in without posting when disabled", async () => {
    const get = vi.spyOn(fetchClient, "GET").mockResolvedValue({
      data: { enabled: false },
      response: new Response(),
    });
    const post = vi.spyOn(fetchClient, "POST");
    const { result } = renderHook(
      () => useExternalPreview("https://example.com"),
      { wrapper: setup().wrapper },
    );
    await waitFor(() => expect(result.current.status.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith("/api/vault/external-previews/status", {
      signal: expect.any(AbortSignal),
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("does not trust cached opt-in before a new opening checks the server", async () => {
    const { client, wrapper } = setup();
    client.setQueryData(["get", "/api/vault/external-previews/status"], {
      enabled: true,
    });
    vi.spyOn(fetchClient, "GET").mockResolvedValue({
      data: { enabled: false },
      response: new Response(),
    });
    const post = vi.spyOn(fetchClient, "POST");
    const { result } = renderHook(
      () => useExternalPreview("https://example.com"),
      { wrapper },
    );
    await waitFor(() =>
      expect(result.current.status.isFetchedAfterMount).toBe(true),
    );
    expect(result.current.enabled).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it("polls pending captures to readiness", async () => {
    vi.spyOn(fetchClient, "GET").mockResolvedValue({
      data: { enabled: true },
      response: new Response(),
    });
    const post = vi
      .spyOn(fetchClient, "POST")
      .mockResolvedValueOnce({
        data: { ...captured, state: "pending", image_url: null },
        response: new Response(),
      })
      .mockResolvedValue({ data: captured, response: new Response() });
    const { result } = renderHook(
      () => useExternalPreview("https://example.com?query=one#section"),
      { wrapper: setup().wrapper },
    );
    await waitFor(() =>
      expect(result.current.preview.data?.state).toBe("pending"),
    );
    await waitFor(() => expect(result.current.preview.data).toEqual(captured), {
      timeout: 3000,
    });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith("/api/vault/external-previews", {
      body: { url: "https://example.com?query=one#section" },
      signal: expect.any(AbortSignal),
    });
  });

  it("does not show the old URL's response while a new URL loads", async () => {
    vi.spyOn(fetchClient, "GET").mockResolvedValue({
      data: { enabled: true },
      response: new Response(),
    });
    vi.spyOn(fetchClient, "POST")
      .mockResolvedValueOnce({ data: captured, response: new Response() })
      .mockImplementationOnce(() => new Promise<never>(() => {}));
    const { result, rerender } = renderHook(
      ({ url }) => useExternalPreview(url),
      {
        initialProps: { url: "https://example.com" },
        wrapper: setup().wrapper,
      },
    );
    await waitFor(() => expect(result.current.preview.data).toEqual(captured));
    rerender({ url: "https://other.example.com" });
    expect(result.current.preview.data).toBeUndefined();
  });

  it.each([
    "notes/local.md",
    "mailto:hello@example.com",
    "file:///tmp/note",
    "clep:page",
    "arxiv:1234.5678",
  ])("does not fetch for %s", (url) => {
    const get = vi.spyOn(fetchClient, "GET");
    const post = vi.spyOn(fetchClient, "POST");
    renderHook(() => useExternalPreview(url), { wrapper: setup().wrapper });
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});

describe("preview URL boundaries", () => {
  it.each(["http://example.com", "https://example.com?a=b#part"])(
    "retains HTTP(S) URL semantics for %s",
    (url) => expect(externalPreviewUrl(url)).toBe(url),
  );

  it.each([
    "https://user:secret@example.com",
    "javascript:alert(1)",
    "//example.com",
    "/notes/page",
    "not a url",
  ])("rejects %s as a capture target", (url) =>
    expect(externalPreviewUrl(url)).toBeNull(),
  );

  it("accepts only the backend's root-relative image route", () => {
    expect(externalPreviewImageUrl(captured.image_url)).toBe(
      captured.image_url,
    );
    for (const url of [
      "https://remote.example/image.jpg",
      "//remote.example/image.jpg",
      "data:image/jpeg;base64,abc",
      "/api/vault/attachments/abc123",
      "/api/vault/external-previews/images/../secret",
      "/api/vault/external-previews/images/abc123?redirect=elsewhere",
    ]) {
      expect(externalPreviewImageUrl(url)).toBeNull();
    }
  });
});
