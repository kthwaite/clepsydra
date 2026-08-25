import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "#/api/schema";

type FeedEntry = components["schemas"]["FeedEntryDto"];
type FeedList = components["schemas"]["FeedListResponse"];

const policyMocks = vi.hoisted(() => {
  const NativeRequest = globalThis.Request;
  const nativeFetch = globalThis.fetch;
  class BrowserLikeRequest extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(
        typeof input === "string" ? new URL(input, "https://ui.test") : input,
        init,
      );
    }
  }
  const fetchMock = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal("Request", BrowserLikeRequest);
  vi.stubGlobal("fetch", fetchMock);

  return {
    NativeRequest,
    nativeFetch,
    fetchMock,
    navigate: vi.fn(),
    openSearch: vi.fn(),
    openInscribe: vi.fn(),
    openLocation: vi.fn(),
    openTab: vi.fn(),
    openTodayJournal: vi.fn(),
    workspaceState: {
      openHistory: [] as Array<{ path: string; openedAt: number }>,
    },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => policyMocks.navigate,
}));

vi.mock("#/components/FeatureFlagsProvider", () => ({
  useFeatureFlags: () => ({ academic: true, feeds: true }),
}));

vi.mock("#/api/bcl", () => ({
  useBcl: () => ({ data: undefined }),
}));

vi.mock("#/api/index", () => ({
  useTags: () => ({ data: [] }),
  useStats: () => ({ data: undefined }),
  useContentIndex: () => ({ data: { items: [] } }),
  useReferenceIssues: () => ({
    data: { items: [], total: 0, limit: 1, offset: 0 },
  }),
}));

vi.mock("#/api/journal", () => ({
  useJournalToday: () => ({ data: undefined }),
}));

vi.mock("#/api/location", () => ({
  useLocation: () => ({ data: undefined }),
}));

vi.mock("#/hooks/useClock", () => ({
  useClock: () => new Date("2026-08-09T12:00:00Z"),
}));

vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => policyMocks.openTab,
}));

vi.mock("#/hooks/useOpenTodayJournal", () => ({
  useOpenTodayJournal: () => policyMocks.openTodayJournal,
}));

vi.mock("#/store/ui", () => ({
  useUiStore: (
    selector: (state: {
      openSearch: typeof policyMocks.openSearch;
      openInscribe: typeof policyMocks.openInscribe;
      openLocation: typeof policyMocks.openLocation;
    }) => unknown,
  ) =>
    selector({
      openSearch: policyMocks.openSearch,
      openInscribe: policyMocks.openInscribe,
      openLocation: policyMocks.openLocation,
    }),
}));

vi.mock("#/store/workspace", () => ({
  useWorkspaceStore: (
    selector: (state: typeof policyMocks.workspaceState) => unknown,
  ) => selector(policyMocks.workspaceState),
}));

vi.mock("#/components/codex/ActivityHeatmap", () => ({
  ActivityHeatmap: () => <div data-testid="activity-heatmap" />,
}));

vi.mock("#/components/codex/AgendaTile", () => ({
  AgendaTile: ({ className }: { className?: string }) => (
    <section aria-label="Outstanding agenda" className={className} />
  ),
}));

vi.mock("#/components/codex/ReadingContinues", () => ({
  ReadingContinuesPanel: () => null,
}));

vi.mock("#/components/codex/SkyCard", () => ({
  SkyCard: () => <section aria-label="Sky" />,
}));

import { Atrium } from "#/components/codex/Atrium";
import { FeedRiver } from "#/components/codex/FeedRiver";
import { queryClient as productionQueryClient } from "#/lib/queryClient";

const feedsKey = ["get", "/api/vault/feeds"] as const;
const allEntriesKey = [
  "get",
  "/api/vault/feeds/entries",
  { params: { query: { view: "all" } } },
] as const;
const unreadEntriesKey = [
  "get",
  "/api/vault/feeds/entries",
  { params: { query: { view: "unread" } } },
] as const;

const feedList: FeedList = {
  counts: {
    unread: 1,
    all: 1,
    saved: 0,
  },
  diagnostics: [],
  groups: [
    {
      name: "Engineering",
      feeds: [
        {
          id: 7,
          title: "One Example",
          title_override: null,
          url: "https://one.example/feed.xml",
          fetch_url: "https://one.example/feed.xml",
          site_url: "https://one.example",
          group: "Engineering",
          tags: ["systems"],
          last_fetch_at: "2026-08-09T12:05:00Z",
          next_fetch_at: "2026-08-09T13:05:00Z",
          error_count: 0,
          last_error: null,
        },
      ],
    },
  ],
  manifest_revision: "revision-1",
  preference_namespace: "fixture-feed-preferences",
};

const cachedEntry: FeedEntry = {
  id: 101,
  feed_id: 7,
  guid: "entry-101",
  title: "Cached dispatch",
  url: "https://one.example/posts/cached-dispatch",
  author: "Kit",
  content_html: "<p>Cached body.</p>",
  published_at: "2026-08-09T12:00:00Z",
  fetched_at: "2026-08-09T12:01:00Z",
  read: false,
  bookmarked: false,
  tags: ["systems"],
};

function productionPolicyClient() {
  const defaults = productionQueryClient.getDefaultOptions();
  return new QueryClient({
    defaultOptions: {
      ...defaults,
      queries: {
        ...defaults.queries,
        // Keep the app's throw policy while making a rejected request settle
        // immediately in this focused integration fixture.
        retry: false,
      },
    },
  });
}

function failedResponse(message: string) {
  return new Response(JSON.stringify({ message }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
}

function requestFrom(input: RequestInfo | URL, init?: RequestInit) {
  return input instanceof policyMocks.NativeRequest
    ? input
    : new Request(input, init);
}

function renderAtrium(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <Atrium />
    </QueryClientProvider>,
  );
}

function expectAtriumSurfaces() {
  expect(screen.getByText("Activity · Rolling 26 weeks")).toBeInTheDocument();
  expect(screen.getByText(/DAYSTART \//)).toBeInTheDocument();
  expect(screen.getByText("FIG. VI")).toBeInTheDocument();
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.stubGlobal("Request", policyMocks.NativeRequest);
  vi.stubGlobal("fetch", policyMocks.nativeFetch);
});

describe("full FeedRiver query policy", () => {
  it("announces a feed-list refetch failure without discarding cached entries", async () => {
    const client = productionPolicyClient();
    client.setQueryData(feedsKey, feedList, { updatedAt: 0 });
    client.setQueryData(
      unreadEntriesKey,
      {
        pages: [{ entries: [cachedEntry], next_cursor: null }],
        pageParams: [undefined],
      },
      { updatedAt: Date.now() },
    );
    policyMocks.fetchMock.mockImplementation(async (input, init) => {
      const request = requestFrom(input, init);
      if (new URL(request.url).pathname === "/api/vault/feeds") {
        return failedResponse("Feed subscriptions unavailable");
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });

    render(
      <QueryClientProvider client={client}>
        <FeedRiver filters={{ view: "unread" }} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /feed subscriptions unavailable|feed subscriptions could not be loaded/i,
    );
    expect(
      screen.getByRole("article", { name: /cached dispatch/i }),
    ).toBeInTheDocument();
  });
});

describe("Atrium feed query policy", () => {
  it("contains an initial feed-list rejection inside the panel", async () => {
    policyMocks.fetchMock.mockImplementation(async (input, init) => {
      const request = requestFrom(input, init);
      if (new URL(request.url).pathname === "/api/vault/feeds") {
        return failedResponse("Feed subscriptions unavailable");
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });

    renderAtrium(productionPolicyClient());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /feed subscriptions unavailable|feed subscriptions could not be loaded/i,
    );
    expectAtriumSurfaces();
  });

  it("retains cached subscriptions and river content when the list refetch fails", async () => {
    const client = productionPolicyClient();
    client.setQueryData(feedsKey, feedList, { updatedAt: 0 });
    client.setQueryData(
      allEntriesKey,
      {
        pages: [{ entries: [cachedEntry], next_cursor: null }],
        pageParams: [undefined],
      },
      { updatedAt: Date.now() },
    );
    policyMocks.fetchMock.mockImplementation(async (input, init) => {
      const request = requestFrom(input, init);
      if (new URL(request.url).pathname === "/api/vault/feeds") {
        return failedResponse("Feed subscriptions unavailable");
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });

    renderAtrium(client);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /feed subscriptions unavailable|feed subscriptions could not be loaded/i,
    );
    expect(
      screen.getByRole("article", { name: /cached dispatch/i }),
    ).toBeInTheDocument();
    expectAtriumSurfaces();
  });

  it("retains cached river content when the entry refetch fails", async () => {
    const client = productionPolicyClient();
    client.setQueryData(feedsKey, feedList, { updatedAt: Date.now() });
    client.setQueryData(
      allEntriesKey,
      {
        pages: [{ entries: [cachedEntry], next_cursor: null }],
        pageParams: [undefined],
      },
      { updatedAt: 0 },
    );
    policyMocks.fetchMock.mockImplementation(async (input, init) => {
      const request = requestFrom(input, init);
      if (new URL(request.url).pathname === "/api/vault/feeds/entries") {
        return failedResponse("Feed entries unavailable");
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });

    renderAtrium(client);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /feed entries unavailable|feed entries could not be loaded/i,
    );
    expect(
      screen.getByRole("article", { name: /cached dispatch/i }),
    ).toBeInTheDocument();
    expectAtriumSurfaces();
  });
});
