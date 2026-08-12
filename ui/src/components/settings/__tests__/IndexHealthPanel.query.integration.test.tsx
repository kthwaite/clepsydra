import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const { navigateMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("#/api/client", () => ({
  $api: {
    useMutation: () =>
      useMutation({
        mutationFn: async () => ({
          pages_indexed: 0,
          pages_removed: 0,
          pages_skipped: 0,
          warnings: [],
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
          throw new Error("warnings endpoint unavailable");
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
  it("keeps repairs usable when warnings fail under the app error policy", async () => {
    const user = userEvent.setup();
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

    expect(
      await screen.findByRole("alert", {
        name: "Index warnings could not be loaded.",
      }),
    ).toHaveTextContent("warnings endpoint unavailable");
    expect(screen.queryByText("Settings crashed.")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Open Reference Repairs" }),
    );

    expect(navigateMock).toHaveBeenCalledWith({ to: "/repairs" });
  });
});
