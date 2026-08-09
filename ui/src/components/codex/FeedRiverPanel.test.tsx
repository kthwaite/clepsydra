import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "#/api/schema";

type FeedList = components["schemas"]["FeedListResponse"];

const panelMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  feedsQuery: {
    data: undefined as FeedList | undefined,
    isPending: false,
    isLoading: false,
    isError: false,
    error: null as Error | null,
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => panelMocks.navigate,
}));

vi.mock("#/api/feeds", () => ({
  useFeeds: () => panelMocks.feedsQuery,
}));

vi.mock("#/components/codex/FeedRiver", () => ({
  FeedRiver: ({
    compact,
    filters,
  }: {
    compact?: boolean;
    filters: { view: string };
  }) => (
    <div
      data-testid="feed-river"
      data-compact={String(compact)}
      data-view={filters.view}
    />
  ),
}));

import { FeedRiverPanel } from "#/components/codex/FeedRiverPanel";

const activeFeedList: FeedList = {
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
};

beforeEach(() => {
  vi.clearAllMocks();
  panelMocks.feedsQuery.data = undefined;
  panelMocks.feedsQuery.isPending = false;
  panelMocks.feedsQuery.isLoading = false;
  panelMocks.feedsQuery.isError = false;
  panelMocks.feedsQuery.error = null;
});

describe("FeedRiverPanel", () => {
  it("announces subscription loading without mounting the river", () => {
    panelMocks.feedsQuery.isPending = true;

    render(<FeedRiverPanel />);

    expect(
      screen.getByRole("status", { name: /loading feed subscriptions/i }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("feed-river")).not.toBeInTheDocument();
  });

  it("offers feed setup when the vault has no subscriptions", async () => {
    const user = userEvent.setup();
    panelMocks.feedsQuery.data = {
      diagnostics: [],
      groups: [],
      manifest_revision: "empty-revision",
    };

    render(<FeedRiverPanel />);

    expect(screen.getByText(/no feed subscriptions/i)).toBeInTheDocument();
    expect(screen.queryByTestId("feed-river")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /set up feeds/i }));

    expect(panelMocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/feeds",
        search: expect.objectContaining({ manage: true }),
      }),
    );
  });

  it("surfaces line-aware manifest diagnostics while retaining the river", () => {
    panelMocks.feedsQuery.data = {
      ...activeFeedList,
      diagnostics: [
        {
          line: 12,
          message: "unknown feed option `interval`",
        },
      ],
    };

    render(<FeedRiverPanel />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      /line 12.*unknown feed option `interval`/i,
    );
    expect(screen.getByTestId("feed-river")).toHaveAttribute(
      "data-compact",
      "true",
    );
  });

  it("renders the compact river, switches views, and opens the full reader", async () => {
    const user = userEvent.setup();
    panelMocks.feedsQuery.data = activeFeedList;

    render(<FeedRiverPanel />);

    const river = screen.getByTestId("feed-river");
    expect(river).toHaveAttribute("data-compact", "true");
    expect(river).toHaveAttribute("data-view", "unread");

    expect(screen.getByRole("button", { name: "Unread" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "All" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Saved" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Saved" }));

    expect(river).toHaveAttribute("data-view", "saved");
    expect(screen.getByRole("button", { name: "Saved" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: /open feed reader/i }));

    expect(panelMocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/feeds",
        search: expect.objectContaining({ view: "saved" }),
      }),
    );
  });
});
