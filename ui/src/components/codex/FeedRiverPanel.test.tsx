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
  counts: {
    unread: 12,
    all: 45,
    saved: 6,
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
      counts: {
        unread: 0,
        all: 0,
        saved: 0,
      },
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

  it("renders live global counts in the caption and accessible view labels", async () => {
    const user = userEvent.setup();
    panelMocks.feedsQuery.data = activeFeedList;

    const { rerender } = render(<FeedRiverPanel />);

    const river = screen.getByTestId("feed-river");
    expect(river).toHaveAttribute("data-compact", "true");
    expect(river).toHaveAttribute("data-view", "unread");
    expect(screen.getByText("12 UNREAD · 6 SAVED · 1 SOURCE")).toBeVisible();

    expect(screen.getByRole("button", { name: "Unread (12)" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "All (45)" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Saved (6)" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Saved (6)" }));

    expect(river).toHaveAttribute("data-view", "saved");
    expect(screen.getByRole("button", { name: "Saved (6)" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    panelMocks.feedsQuery.data = {
      ...activeFeedList,
      counts: {
        unread: 7,
        all: 46,
        saved: 8,
      },
    };
    rerender(<FeedRiverPanel />);

    expect(screen.getByText("7 UNREAD · 8 SAVED · 1 SOURCE")).toBeVisible();
    expect(screen.getByRole("button", { name: "Unread (7)" })).toBeVisible();
    expect(screen.getByRole("button", { name: "All (46)" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Saved (8)" })).toHaveAttribute(
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

  it("keeps counts and the reader action in a wrapping 320px Card header", () => {
    panelMocks.feedsQuery.data = activeFeedList;
    render(
      <div style={{ width: 320 }}>
        <FeedRiverPanel />
      </div>,
    );

    const caption = screen.getByText("12 UNREAD · 6 SAVED · 1 SOURCE");
    const action = screen.getByRole("button", { name: "Open feed reader" });
    const headerCluster = action.parentElement;
    const cardHeader = headerCluster?.parentElement;
    if (!headerCluster || !cardHeader) {
      throw new Error("Expected caption and action inside the Card header");
    }

    expect(cardHeader).toHaveClass("min-w-0", "flex-wrap");
    expect(headerCluster).toHaveClass("min-w-0", "flex-wrap");
    expect(headerCluster).not.toHaveClass("flex-shrink-0");
    expect(caption).toHaveClass("whitespace-normal");
    expect(action).toHaveClass("shrink-0");

    expect(screen.getByRole("button", { name: "Unread (12)" })).toBeVisible();
    expect(screen.getByRole("button", { name: "All (45)" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Saved (6)" })).toBeVisible();
    expect(action).toBeVisible();
  });
});
