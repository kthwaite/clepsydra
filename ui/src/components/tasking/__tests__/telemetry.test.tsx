import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchClient } from "#/api/client";
import { useBoardStore } from "#/store/board";
import { TaskingScreen } from "../TaskingScreen";
import { BOARD_FIXTURE, BOARD_FIXTURE_WITH_NO_SLUG_OP } from "./fixtures";

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, throwOnError: true } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TaskingScreen />
    </QueryClientProvider>,
  );
}

function stubTelemetryFetch({
  empty = false,
  board = BOARD_FIXTURE,
}: {
  empty?: boolean;
  board?: typeof BOARD_FIXTURE;
} = {}) {
  const completionDays = empty
    ? Array.from({ length: 14 }, (_, index) => ({
        date: `2026-06-${String(index + 1).padStart(2, "0")}`,
        count: 0,
      }))
    : [
        { date: "2026-06-01", count: 0 },
        { date: "2026-06-02", count: 2 },
        { date: "2026-06-03", count: 1 },
      ];
  const points = empty
    ? []
    : [
        { date: "2026-05-26", remaining: 4 },
        { date: "2026-05-27", remaining: 3 },
        { date: "2026-05-28", remaining: 1 },
      ];

  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(board), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ),
  );
  return vi.spyOn(fetchClient, "GET").mockImplementation(((path: string) =>
    Promise.resolve({
      data: path.includes("tasks/history")
        ? { days: completionDays }
        : { cycle: "C-01", points },
      error: undefined,
      response: new Response(null, { status: 200 }),
    })) as never);
}

describe("tasking telemetry", () => {
  beforeEach(() => {
    useBoardStore.setState({ mode: "card", opFilter: "ALL", cycleSel: "" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders backend completion counts in the 14-day seal history", async () => {
    const get = stubTelemetryFetch();
    renderScreen();

    expect(
      await screen.findByLabelText("14-day seal history: 0, 2, 1"),
    ).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/api/vault/tasks/history", {
      params: {
        query: { days: 14, project: undefined, unfiled: undefined },
      },
    });
  });

  it("requests an explicit unfiled telemetry scope", async () => {
    useBoardStore.setState({ opFilter: "UNFILED" });
    const get = stubTelemetryFetch();
    renderScreen();

    expect(
      await screen.findByLabelText("14-day seal history: 0, 2, 1"),
    ).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/api/vault/tasks/history", {
      params: {
        query: { days: 14, project: undefined, unfiled: true },
      },
    });
  });

  it("marks project-less operation telemetry as not applicable", async () => {
    useBoardStore.setState({ opFilter: "OPS-3" });
    const get = stubTelemetryFetch({ board: BOARD_FIXTURE_WITH_NO_SLUG_OP });
    renderScreen();

    expect(await screen.findByText("NOT APPLICABLE")).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it("renders backend remaining counts for the selected cycle", async () => {
    useBoardStore.setState({ mode: "cycle", cycleSel: "C-01" });
    stubTelemetryFetch();
    renderScreen();

    expect(
      await screen.findByLabelText("Cycle burndown: 4, 3, 1"),
    ).toBeInTheDocument();
  });

  it("shows honest empty states when no seals or cycle history exist", async () => {
    useBoardStore.setState({ mode: "cycle", cycleSel: "C-01" });
    stubTelemetryFetch({ empty: true });
    renderScreen();

    expect(await screen.findByText("NO SEALS")).toBeInTheDocument();
    expect(await screen.findByText("NO HISTORY")).toBeInTheDocument();
  });

  it("keeps the board visible when telemetry queries fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(BOARD_FIXTURE), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );
    vi.spyOn(fetchClient, "GET").mockResolvedValue({
      data: undefined,
      error: { error: "telemetry unavailable" },
      response: new Response(null, { status: 500 }),
    } as never);
    useBoardStore.setState({ mode: "cycle", cycleSel: "C-01" });
    renderScreen();

    expect(await screen.findByText("TASKING BOARD")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByText("UNAVAILABLE")).toHaveLength(2);
    });
  });
});
