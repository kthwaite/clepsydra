import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("#/api/client", () => ({
  $api: {
    useMutation: () =>
      useMutation({
        mutationFn: async () => ({
          id: "created",
          path: "created.md",
          title: "Created",
        }),
      }),
    useQuery: (
      method: string,
      path: string,
      _init?: unknown,
      options?: { throwOnError?: boolean },
    ) =>
      useQuery({
        queryKey: [method, path],
        queryFn: async () => {
          if (path.endsWith("/ambiguous")) {
            throw new Error("ambiguous endpoint unavailable");
          }
          if (path.endsWith("/unresolved")) {
            return [
              {
                source_id: "source-1",
                source_path: "notes/source.md",
                target_raw: "Ghost",
                target_canonical: "ghost",
                kind: "wikilink",
                span_start: 12,
                reason: "no_match",
                candidates: [],
              },
            ];
          }
          return ["Healthy warning stream"];
        },
        retry: false,
        ...options,
      }),
  },
  fetchClient: {},
}));

import { IndexHealthPanel } from "#/components/settings/IndexHealthPanel";

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
    if (this.state.error) return <p>Settings crashed.</p>;
    return this.props.children;
  }
}

describe("IndexHealthPanel query integration", () => {
  it("renders successful diagnostics when one query fails under the app error policy", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, throwOnError: true },
      },
    });

    render(
      <QueryClientProvider client={client}>
        <TestErrorBoundary>
          <IndexHealthPanel />
        </TestErrorBoundary>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("notes/source.md")).toBeVisible();
    expect(screen.getByText("Healthy warning stream")).toBeVisible();
    expect(
      screen.getByRole("alert", {
        name: "Ambiguous names could not be loaded.",
      }),
    ).toBeVisible();
    expect(screen.queryByText("Settings crashed.")).not.toBeInTheDocument();
  });
});
