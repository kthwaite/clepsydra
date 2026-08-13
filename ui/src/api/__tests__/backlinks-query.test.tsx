import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("#/api/client", () => ({
  $api: {
    useQuery: (
      method: string,
      path: string,
      _init?: unknown,
      options?: { enabled?: boolean; throwOnError?: boolean },
    ) =>
      useQuery({
        queryKey: [method, path],
        queryFn: async () => {
          throw new Error("backlinks endpoint unavailable");
        },
        retry: false,
        ...options,
      }),
  },
  fetchClient: {},
}));

import { useBacklinks } from "#/api/index";

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
    if (this.state.error) return <p>Folio crashed.</p>;
    return this.props.children;
  }
}

function BacklinksQueryProbe() {
  const backlinks = useBacklinks("notes/target.md");
  if (backlinks.isError) return <p role="alert">Backlinks unavailable.</p>;
  return <p>{backlinks.status}</p>;
}

describe("useBacklinks query error policy", () => {
  it("settles in error state instead of throwing through the folio boundary", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, throwOnError: true },
      },
    });

    render(
      <QueryClientProvider client={client}>
        <TestErrorBoundary>
          <BacklinksQueryProbe />
        </TestErrorBoundary>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Backlinks unavailable.",
    );
    expect(screen.queryByText("Folio crashed.")).not.toBeInTheDocument();
  });
});
