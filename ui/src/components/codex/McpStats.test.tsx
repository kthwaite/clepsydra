import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "#/api/schema";
import { Stats } from "#/components/codex/Stats";

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

vi.mock("#/api/index", () => ({
  useStats: () => ({ data: undefined }),
  useTags: () => ({ data: [] }),
  useContentIndex: () => ({ data: { items: [] } }),
  useReferenceIssues: () => ({ data: undefined }),
}));

type McpStatsResponse = components["schemas"]["McpStatsResponse"];
const recorded: McpStatsResponse = {
  days: 30,
  tracking_since: "2026-11-01T09:00:00Z",
  total_calls: 12,
  successful_calls: 11,
  failed_calls: 1,
  sessions: 2,
  agents: 1,
  pages: 2,
  average_duration_ms: 12.5,
  tools: [
    {
      name: "vault_get_page",
      read_only: true,
      calls: 12,
      failures: 1,
      average_duration_ms: 12.5,
      last_used_at: "2026-11-13T10:00:00Z",
    },
    {
      name: "vault_create_page",
      read_only: false,
      calls: 0,
      failures: 0,
      average_duration_ms: 0,
      last_used_at: null,
    },
  ],
  clients: [
    {
      name: "Research assistant",
      client_name: "Example client",
      client_version: "1.2",
      calls: 12,
      failures: 1,
      sessions: 2,
      average_duration_ms: 12.5,
      last_used_at: "2026-11-13T10:00:00Z",
    },
  ],
  page_activity: [
    {
      page_id: "page-1",
      path: "notes/garden.md",
      title: "Garden notes",
      calls: 10,
      target_calls: 8,
      result_calls: 9,
      last_used_at: "2026-11-13T10:00:00Z",
    },
    {
      page_id: "missing-page",
      path: "notes/deleted.md",
      title: null,
      calls: 2,
      target_calls: 2,
      result_calls: 0,
      last_used_at: "2026-11-12T10:00:00Z",
    },
  ],
  daily: [{ date: "2026-11-13", calls: 12, failures: 1 }],
  recent_calls: [
    {
      call_id: "call-1",
      tool: "vault_get_page",
      client_name: "Example client",
      agent_label: "Research assistant",
      started_at: "2026-11-13T10:00:00Z",
      duration_ms: 15,
      outcome: "protocol_error",
      error_code: -32602,
      pages: [{ page_id: "page-1", path: "notes/garden.md", source: "target" }],
    },
  ],
};
const empty: McpStatsResponse = {
  days: 30,
  tracking_since: null,
  total_calls: 0,
  successful_calls: 0,
  failed_calls: 0,
  sessions: 0,
  agents: 0,
  pages: 0,
  average_duration_ms: 0,
  tools: [],
  clients: [],
  page_activity: [],
  daily: [],
  recent_calls: [],
};
let payload = recorded;
let status = 200;
const requestedDays: string[] = [];
const queryClients: QueryClient[] = [];

beforeEach(() => {
  payload = recorded;
  status = 200;
  requestedDays.length = 0;
  transport.fetch.mockReset();
  transport.fetch.mockImplementation(async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    const url = new URL(request.url);
    if (url.pathname !== "/api/vault/mcp/stats")
      throw new Error(`Unexpected URL: ${url}`);
    const days = url.searchParams.get("days") ?? "30";
    requestedDays.push(days);
    return Response.json(
      status === 200
        ? { ...payload, days: Number(days) }
        : { error: "Analytics unavailable" },
      { status },
    );
  });
});

afterEach(() => {
  cleanup();
  for (const client of queryClients) client.clear();
  queryClients.length = 0;
});

function renderStats() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, throwOnError: true } },
  });
  queryClients.push(client);
  const root = createRootRoute({ component: Outlet });
  const stats = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: Stats,
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/pages/$",
    component: () => <h1>Opened garden page</h1>,
  });
  const router = createRouter({
    routeTree: root.addChildren([stats, page]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

async function openMcp() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "MCP" }));
  return user;
}

describe("MCP statistics", () => {
  it("keeps inventory as the default and requests analytics only when its tab is selected", async () => {
    renderStats();
    expect(
      await screen.findByRole("heading", { name: "Inventory" }),
    ).toBeVisible();
    expect(screen.getByRole("tab", { name: "Vault" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(transport.fetch).not.toHaveBeenCalled();
    const user = await openMcp();
    expect(
      await screen.findByRole("table", { name: "Tool usage" }),
    ).toBeVisible();
    expect(requestedDays).toEqual(["30"]);
    expect(
      screen.queryByRole("heading", { name: "Inventory" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Vault" }));
    expect(screen.getByRole("heading", { name: "Inventory" })).toBeVisible();
    expect(
      screen.queryByRole("table", { name: "Tool usage" }),
    ).not.toBeInTheDocument();
  });

  it("changes the query window and refreshes the selected range", async () => {
    renderStats();
    const user = await openMcp();
    await screen.findByRole("table", { name: "Tool usage" });
    for (const days of ["7", "90", "0"]) {
      await user.selectOptions(
        screen.getByRole("combobox", { name: "Date range" }),
        days,
      );
      await waitFor(() => expect(requestedDays.at(-1)).toBe(days));
      await screen.findByRole("table", { name: "Tool usage" });
    }
    await user.click(
      screen.getByRole("button", { name: "Refresh MCP statistics" }),
    );
    await waitFor(() =>
      expect(requestedDays).toEqual(["30", "7", "90", "0", "0"]),
    );
  });

  it("shows unused tools, client identity, daily counts and failed recent calls", async () => {
    renderStats();
    await openMcp();
    const tools = await screen.findByRole("table", { name: "Tool usage" });
    const unused = within(tools).getByRole("row", {
      name: /vault_create_page/,
    });
    expect(within(unused).getByText("Unused in this range")).toBeVisible();
    expect(within(unused).getByText("May write")).toBeVisible();
    const clients = screen.getByRole("table", { name: "Agents and clients" });
    expect(within(clients).getByText("Research assistant")).toBeVisible();
    expect(within(clients).getByText("Example client · 1.2")).toBeVisible();
    expect(screen.getByText(/self-reported/)).toBeVisible();
    expect(
      screen.getByRole("table", { name: "Daily activity" }),
    ).toHaveTextContent("2026-11-13");
    const recent = screen.getByRole("table", { name: "Recent calls" });
    expect(recent).toHaveTextContent("Protocol error");
    expect(recent).toHaveTextContent("-32602");
    expect(recent).toHaveTextContent("1 target");
  });

  it("links current pages, keeps unresolved references non-interactive, and explains attribution", async () => {
    const router = renderStats();
    const user = await openMcp();
    const link = await screen.findByRole("link", { name: "Garden notes" });
    expect(link).toHaveAttribute("href", "/pages/notes/garden.md");
    expect(
      screen.queryByRole("link", { name: /deleted/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("notes/deleted.md")).toBeVisible();
    expect(screen.getByText(/not proof of successful access/)).toBeVisible();
    await user.click(link);
    expect(
      await screen.findByRole("heading", { name: "Opened garden page" }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe("/pages/notes/garden.md");
  });

  it("retains previously loaded counts and identifies them as stale after refresh fails", async () => {
    renderStats();
    const user = await openMcp();
    await screen.findByRole("table", { name: "Tool usage" });
    status = 503;
    await user.click(
      screen.getByRole("button", { name: "Refresh MCP statistics" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Showing the last loaded counts",
    );
    expect(screen.getByRole("table", { name: "Tool usage" })).toHaveTextContent(
      "vault_get_page",
    );
    expect(
      screen.queryByText("No MCP calls in this range."),
    ).not.toBeInTheDocument();
  });

  it("shows a local error rather than fake zero counts and recovers with refresh", async () => {
    status = 503;
    renderStats();
    const user = await openMcp();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Analytics unavailable",
    );
    expect(
      screen.queryByText("No MCP calls in this range."),
    ).not.toBeInTheDocument();
    status = 200;
    await user.click(
      screen.getByRole("button", { name: "Refresh MCP statistics" }),
    );
    expect(
      await screen.findByRole("table", { name: "Tool usage" }),
    ).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("distinguishes pending requests from an empty database", async () => {
    // The test runtime supports withResolvers; the app's ES2022 types do not.
    const promises = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve(value: T): void };
    };
    const pending = promises.withResolvers<Response>();
    transport.fetch.mockImplementationOnce(() => pending.promise);
    renderStats();
    await openMcp();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading MCP statistics",
    );
    expect(
      screen.queryByText("No MCP calls in this range."),
    ).not.toBeInTheDocument();
    pending.resolve(Response.json(empty));
    expect(
      await screen.findByText("No MCP calls in this range."),
    ).toBeVisible();
    expect(screen.getByText("Tracking has not started yet.")).toBeVisible();
    expect(screen.getByText("No tool catalog recorded yet.")).toBeVisible();
  });

  it("keeps the registered catalog visible when the selected range has no calls", async () => {
    payload = {
      ...empty,
      tracking_since: recorded.tracking_since,
      tools: recorded.tools.filter((tool) => tool.calls === 0),
    };
    renderStats();
    await openMcp();
    expect(
      await screen.findByText("No MCP calls in this range."),
    ).toBeVisible();
    expect(screen.getByRole("table", { name: "Tool usage" })).toHaveTextContent(
      "vault_create_page",
    );
    expect(screen.getByText("Unused in this range")).toBeVisible();
  });
});
