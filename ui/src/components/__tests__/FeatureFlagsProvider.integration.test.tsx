import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FeatureFlagsProvider,
  useFeatureFlags,
} from "#/components/FeatureFlagsProvider";

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
    if (this.state.error) return <p>Capability boundary crashed.</p>;
    return this.props.children;
  }
}

function FeatureSnapshot() {
  const flags = useFeatureFlags();
  return (
    <div>
      academic:{flags.academic ? "on" : "off"} feeds:
      {flags.feeds ? "on" : "off"}
    </div>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FeatureFlagsProvider query errors", () => {
  it("fails closed instead of throwing through the app query boundary", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("capability request failed"),
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, throwOnError: true },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <TestErrorBoundary>
          <FeatureFlagsProvider>
            <FeatureSnapshot />
          </FeatureFlagsProvider>
        </TestErrorBoundary>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("academic:off feeds:off")).toBeVisible();
    expect(
      screen.queryByText("Capability boundary crashed."),
    ).not.toBeInTheDocument();
  });
});
