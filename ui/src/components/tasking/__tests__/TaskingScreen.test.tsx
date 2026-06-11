import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskingScreen } from "../TaskingScreen";

/** Fresh client per render — retry off so error states surface immediately. */
function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TaskingScreen />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TaskingScreen smoke", () => {
  it("renders the loading state while the board query is in flight", () => {
    // A fetch that never resolves keeps the query pending.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    renderScreen();
    expect(screen.getByText("LOADING")).toBeInTheDocument();
  });

  it("renders the error state when the board fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );
    renderScreen();
    expect(
      await screen.findByText(/ERROR — board unavailable/),
    ).toBeInTheDocument();
  });
});
