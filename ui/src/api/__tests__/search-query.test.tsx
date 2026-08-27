import {
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const searchRequestMock = vi.hoisted(() => vi.fn());

vi.mock("#/api/client", () => ({
  $api: {
    useQuery: (
      method: string,
      path: string,
      init?: { params?: { query?: { q?: string; limit?: number } } },
      options?: {
        enabled?: boolean;
        retry?: (failureCount: number, error: unknown) => boolean;
        throwOnError?: boolean;
      },
    ) =>
      useQuery({
        queryKey: [method, path, init?.params?.query],
        queryFn: searchRequestMock,
        retryDelay: 0,
        ...options,
      }),
  },
  fetchClient: {},
}));

import { isInvalidSearchQuery } from "#/api/error";
import { useSearch } from "#/api/index";
import { queryClient } from "#/lib/queryClient";

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

beforeEach(() => {
  queryClient.clear();
  searchRequestMock.mockReset();
});

afterEach(() => {
  queryClient.clear();
});

describe("useSearch query error policy", () => {
  it("keeps invalid syntax in query state without retrying", async () => {
    searchRequestMock.mockRejectedValue({
      status: 400,
      error: "unknown search field 'knd' at column 1",
      detail: {
        code: "invalid_search_query",
        span: { start: 0, end: 3 },
        kind: "unknown_field",
      },
    });

    renderSearchProbe();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid search query.",
    );
    expect(screen.queryByText("Application route failed.")).not.toBeInTheDocument();
    await waitFor(() => expect(searchRequestMock).toHaveBeenCalledOnce());
  });

  it("keeps ordinary failures retryable with the default retry bound", async () => {
    searchRequestMock.mockRejectedValue(new Error("Search unavailable"));

    renderSearchProbe();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Search unavailable.",
    );
    expect(screen.queryByText("Application route failed.")).not.toBeInTheDocument();
    await waitFor(() => expect(searchRequestMock).toHaveBeenCalledTimes(4));
  });
});
