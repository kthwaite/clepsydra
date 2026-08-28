import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const transport = vi.hoisted(() => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const NativeRequest = globalThis.Request;
  class SameOriginRequest extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(
        typeof input === "string" && input.startsWith("/")
          ? new URL(input, "http://localhost")
          : input,
        init,
      );
    }
  }
  vi.stubGlobal("Request", SameOriginRequest);
  vi.stubGlobal("fetch", fetch);
  return { fetch };
});

import { isInvalidSearchQuery } from "#/api/error";
import { useSearch } from "#/api/index";
import { queryClient } from "#/lib/queryClient";

const originalDefaultOptions = queryClient.getDefaultOptions();

class TestErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {}

  render() {
    if (this.state.error) return <p>Application route failed.</p>;
    return this.props.children;
  }
}

function SearchQueryProbe() {
  const search = useSearch("knd:recipe", 12);
  if (search.isError) {
    return (
      <p role="alert">
        {isInvalidSearchQuery(search.error)
          ? "Invalid search query."
          : "Search unavailable."}
      </p>
    );
  }
  return <p>{search.status}</p>;
}

function renderSearchProbe() {
  render(
    <QueryClientProvider client={queryClient}>
      <TestErrorBoundary>
        <SearchQueryProbe />
      </TestErrorBoundary>
    </QueryClientProvider>,
  );
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeAll(() => {
  queryClient.setDefaultOptions({
    ...originalDefaultOptions,
    queries: {
      ...originalDefaultOptions.queries,
      retryDelay: 0,
    },
  });
});

beforeEach(() => {
  queryClient.clear();
  transport.fetch.mockReset();
});

afterEach(() => {
  queryClient.clear();
});

afterAll(() => {
  queryClient.setDefaultOptions(originalDefaultOptions);
});

describe("useSearch query error policy", () => {
  it("keeps an invalid-syntax response in query state without retrying", async () => {
    transport.fetch.mockResolvedValue(
      jsonResponse(
        {
          status: 400,
          error: "unknown search field 'knd' at column 1",
          detail: {
            code: "invalid_search_query",
            span: { start: 0, end: 3 },
            kind: "unknown_field",
          },
        },
        400,
      ),
    );

    renderSearchProbe();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid search query.",
    );
    expect(
      screen.queryByText("Application route failed."),
    ).not.toBeInTheDocument();
    expect(transport.fetch).toHaveBeenCalledOnce();
  });

  it("keeps ordinary server failures retryable with the default bound", async () => {
    transport.fetch.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(
          { status: 500, error: "Search unavailable", detail: null },
          500,
        ),
      ),
    );

    renderSearchProbe();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Search unavailable.",
    );
    expect(
      screen.queryByText("Application route failed."),
    ).not.toBeInTheDocument();
    expect(transport.fetch).toHaveBeenCalledTimes(4);
  });
});
