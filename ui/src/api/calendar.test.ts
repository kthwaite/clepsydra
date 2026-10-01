import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCalendarEntries } from "#/api/calendar";
import { useEnsureJournalForDate } from "#/api/journal";
import { invalidateByPath } from "#/api/keys";
import { monthGridRange } from "#/lib/calendar/dates";

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function entries(title: string) {
  return json({
    entries: [{ path: `${title}.md`, title, kind: "NOTE" }],
    truncated: false,
  });
}

function setup() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  return { qc, wrapper };
}

function requestUrl(call = 0): URL {
  const input = fetchMock.mock.calls[call]?.[0];
  if (!(input instanceof Request)) throw new Error("expected a Request");
  return new URL(input.url);
}

function withTz<T>(tz: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  return run().finally(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });
}

describe("useCalendarEntries", () => {
  it("sends offset-bearing bounds and a sorted comma kind list", () =>
    withTz("Europe/London", async () => {
      fetchMock.mockResolvedValue(entries("a"));
      const { wrapper } = setup();
      const range = monthGridRange(2026, 2);
      const { result } = renderHook(
        () => useCalendarEntries({ range, kinds: ["NOTE", "JOURNAL"] }),
        { wrapper },
      );
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      const url = requestUrl();
      expect(url.pathname).toBe("/api/vault/index/calendar");
      expect(url.searchParams.get("from")).toBe("2026-02-23T00:00:00+00:00");
      expect(url.searchParams.get("to")).toBe("2026-04-06T00:00:00+01:00");
      expect(url.searchParams.get("kind")).toBe("JOURNAL,NOTE");
    }));

  it("omits kind when no kinds are given", async () => {
    fetchMock.mockResolvedValue(entries("a"));
    const { wrapper } = setup();
    const range = monthGridRange(2026, 2);
    const { result } = renderHook(
      () => useCalendarEntries({ range, kinds: [], tag: "t", project: "p" }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = requestUrl();
    expect(url.searchParams.has("kind")).toBe(false);
    expect(url.searchParams.get("tag")).toBe("t");
    expect(url.searchParams.get("project")).toBe("p");
  });

  it("does not fetch when disabled", async () => {
    const { wrapper } = setup();
    const range = monthGridRange(2026, 2);
    const { result } = renderHook(
      () => useCalendarEntries({ range }, { enabled: false }),
      { wrapper },
    );
    await Promise.resolve();
    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps previous data while the next month loads", async () => {
    let release: (() => void) | undefined;
    fetchMock.mockResolvedValueOnce(entries("first")).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(entries("second"));
        }),
    );
    const { wrapper } = setup();
    const { result, rerender } = renderHook(
      ({ month }) => useCalendarEntries({ range: monthGridRange(2026, month) }),
      { wrapper, initialProps: { month: 2 } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ month: 3 });
    expect(result.current.data?.entries[0]?.title).toBe("first");
    expect(result.current.isPlaceholderData).toBe(true);

    release?.();
    await waitFor(() =>
      expect(result.current.data?.entries[0]?.title).toBe("second"),
    );
  });

  it("surfaces birthdays from the response", async () => {
    const ada = {
      path: "people/ada.md",
      title: "Ada",
      year: 1983,
      month: 5,
      day: 12,
    };
    fetchMock.mockImplementation(async () =>
      json({ entries: [], birthdays: [ada], truncated: false }),
    );
    const { wrapper } = setup();
    const range = monthGridRange(2026, 4);
    const { result } = renderHook(() => useCalendarEntries({ range }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.birthdays).toEqual([ada]);
  });

  it("reads a response without birthdays as none", async () => {
    fetchMock.mockImplementation(async () => entries("a"));
    const { wrapper } = setup();
    const range = monthGridRange(2026, 4);
    const { result } = renderHook(() => useCalendarEntries({ range }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.birthdays).toEqual([]);
  });

  it("is invalidated by the /api/vault/index prefix", async () => {
    fetchMock.mockImplementation(async () => entries("a"));
    const { qc, wrapper } = setup();
    const range = monthGridRange(2026, 2);
    const { result } = renderHook(() => useCalendarEntries({ range }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [query] = qc.getQueryCache().findAll({
      predicate: (q) => q.queryKey[1] === "/api/vault/index/calendar",
    });
    expect(query?.queryKey[0]).toBe("get");
    expect(query?.state.isInvalidated).toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // An active query that is invalidated refetches.
    await invalidateByPath(qc, "/api/vault/index");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

describe("useEnsureJournalForDate", () => {
  const page = {
    path: "journals/20260930.2026-09-02.abcd1234.md",
    canonical_name: "2026-09-02",
    revision: "rev-a",
    body: "",
    meta: { id: "019fc7fc-5ceb-7cd1-a312-e03266ff3f62", title: "2026-09-02" },
  };

  it("posts to the date path and returns created", async () => {
    fetchMock.mockResolvedValue(json(page, 201));
    const { wrapper } = setup();
    const { result } = renderHook(() => useEnsureJournalForDate(), {
      wrapper,
    });
    const out = await result.current.mutateAsync("2026-09-02");
    const input = fetchMock.mock.calls[0]?.[0] as Request;
    expect(input.method).toBe("POST");
    expect(new URL(input.url).pathname).toBe("/api/vault/journal/2026-09-02");
    expect(out.created).toBe(true);
    expect(out.page.path).toBe(page.path);
  });

  it("reports created=false when the journal already existed", async () => {
    fetchMock.mockResolvedValue(json(page, 200));
    const { wrapper } = setup();
    const { result } = renderHook(() => useEnsureJournalForDate(), {
      wrapper,
    });
    const out = await result.current.mutateAsync("2026-09-02");
    expect(out.created).toBe(false);
  });

  it("rejects with the server error message", async () => {
    fetchMock.mockResolvedValue(json({ error: "bad date", status: 400 }, 400));
    const { wrapper } = setup();
    const { result } = renderHook(() => useEnsureJournalForDate(), {
      wrapper,
    });
    await expect(result.current.mutateAsync("nope")).rejects.toThrow(
      "bad date",
    );
  });
});
