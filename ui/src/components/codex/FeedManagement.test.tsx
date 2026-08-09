import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "#/api/schema";

type FeedList = components["schemas"]["FeedListResponse"];

const managementMocks = vi.hoisted(() => ({
  feedsQuery: {
    data: undefined as FeedList | undefined,
    isPending: false,
    isLoading: false,
    isError: false,
    error: null as Error | null,
  },
  subscribeFeed: vi.fn(),
  updateFeed: vi.fn(),
  deleteFeed: vi.fn(),
  refreshFeeds: vi.fn(),
  importOpml: vi.fn(),
  exportOpml: vi.fn(),
}));

vi.mock("#/api/feeds", () => ({
  useFeeds: () => managementMocks.feedsQuery,
  useSubscribeFeed: () => ({
    mutate: managementMocks.subscribeFeed,
    mutateAsync: managementMocks.subscribeFeed,
    isPending: false,
  }),
  useUpdateFeed: () => ({
    mutate: managementMocks.updateFeed,
    mutateAsync: managementMocks.updateFeed,
    isPending: false,
  }),
  useDeleteFeed: () => ({
    mutate: managementMocks.deleteFeed,
    mutateAsync: managementMocks.deleteFeed,
    isPending: false,
  }),
  useRefreshFeeds: () => ({
    mutate: managementMocks.refreshFeeds,
    mutateAsync: managementMocks.refreshFeeds,
    isPending: false,
  }),
  useImportOpml: () => ({
    mutate: managementMocks.importOpml,
    mutateAsync: managementMocks.importOpml,
    isPending: false,
  }),
  exportOpml: managementMocks.exportOpml,
}));

import { FeedManagement } from "#/components/codex/FeedManagement";

const feedList: FeedList = {
  diagnostics: [
    {
      line: 12,
      message: "unknown feed option `interval`",
    },
  ],
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
          tags: ["rust", "systems"],
          last_fetch_at: "2026-08-09T12:05:00Z",
          next_fetch_at: "2026-08-09T13:05:00Z",
          error_count: 2,
          last_error: "Timeout contacting origin",
        },
      ],
    },
  ],
  manifest_revision: "revision-1",
};

function renderManagement() {
  return render(<FeedManagement />);
}

beforeEach(() => {
  vi.clearAllMocks();
  managementMocks.feedsQuery.data = feedList;
  managementMocks.feedsQuery.isPending = false;
  managementMocks.feedsQuery.isLoading = false;
  managementMocks.feedsQuery.isError = false;
  managementMocks.feedsQuery.error = null;
  managementMocks.exportOpml.mockResolvedValue(
    '<?xml version="1.0"?><opml version="2.0"><body /></opml>',
  );
});

describe("FeedManagement", () => {
  it("supports keyboard-only subscription in predictable focus order", async () => {
    const user = userEvent.setup();
    renderManagement();

    await user.tab();
    const url = screen.getByRole("textbox", { name: /feed or site url/i });
    expect(url).toHaveFocus();
    await user.type(url, "https://one.example/feed");

    await user.tab();
    const group = screen.getByRole("textbox", { name: /^group$/i });
    expect(group).toHaveFocus();
    await user.type(group, "Tech");

    await user.tab();
    expect(screen.getByRole("button", { name: /^subscribe$/i })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(managementMocks.subscribeFeed).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://one.example/feed",
        group: "Tech",
      }),
    );
  });

  it("renders a named loading status", () => {
    managementMocks.feedsQuery.data = undefined;
    managementMocks.feedsQuery.isPending = true;
    managementMocks.feedsQuery.isLoading = true;

    renderManagement();

    expect(
      screen.getByRole("status", { name: /loading subscriptions/i }),
    ).toBeVisible();
  });

  it("renders manifest query failures as an alert", () => {
    managementMocks.feedsQuery.data = undefined;
    managementMocks.feedsQuery.isError = true;
    managementMocks.feedsQuery.error = new Error("manifest read failed");

    renderManagement();

    expect(screen.getByRole("alert")).toHaveTextContent("manifest read failed");
  });

  it("keeps subscription setup available for an empty manifest", () => {
    managementMocks.feedsQuery.data = {
      diagnostics: [],
      groups: [],
      manifest_revision: "empty-revision",
    };

    renderManagement();

    expect(screen.getByText(/no subscriptions yet/i)).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: /feed or site url/i }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: /^subscribe$/i })).toBeEnabled();
  });

  it("surfaces manifest diagnostics and feed health details", () => {
    renderManagement();

    expect(screen.getByRole("alert")).toHaveTextContent(
      /line 12.*unknown feed option `interval`/i,
    );
    const item = screen.getByText("One Example").closest("li");
    expect(item).not.toBeNull();
    const feed = within(item as HTMLElement);
    expect(feed.getByLabelText(/unhealthy|degraded/i)).toBeVisible();
    expect(feed.getByText(/2 errors/i)).toBeVisible();
    expect(feed.getByText(/timeout contacting origin/i)).toBeVisible();
    expect(feed.getByText(/last fetch/i)).toBeVisible();
    expect(feed.getByText(/next fetch/i)).toBeVisible();
  });

  it("edits a subscription title and group in an accessible dialog", async () => {
    const user = userEvent.setup();
    renderManagement();

    await user.click(screen.getByRole("button", { name: /edit one example/i }));
    const dialog = screen.getByRole("dialog", { name: /edit one example/i });
    const title = within(dialog).getByRole("textbox", { name: /^title$/i });
    const group = within(dialog).getByRole("textbox", { name: /^group$/i });
    await user.clear(title);
    await user.type(title, "Renamed Feed");
    await user.clear(group);
    await user.type(group, "Research");
    await user.click(
      within(dialog).getByRole("button", { name: /save changes/i }),
    );

    expect(managementMocks.updateFeed).toHaveBeenCalledWith({
      id: 7,
      title: "Renamed Feed",
      group: "Research",
    });
  });

  it("requires confirmation before unsubscribe", async () => {
    const user = userEvent.setup();
    renderManagement();

    await user.click(
      screen.getByRole("button", { name: /unsubscribe one example/i }),
    );
    expect(managementMocks.deleteFeed).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", {
      name: /unsubscribe one example/i,
    });

    await user.click(
      within(dialog).getByRole("button", { name: /confirm unsubscribe/i }),
    );

    expect(managementMocks.deleteFeed).toHaveBeenCalledWith({ id: 7 });
  });

  it("requests a feed refresh from the management surface", async () => {
    const user = userEvent.setup();
    renderManagement();

    await user.click(screen.getByRole("button", { name: /refresh feeds/i }));

    expect(managementMocks.refreshFeeds).toHaveBeenCalledTimes(1);
  });

  it("imports the selected OPML document through the generated mutation", async () => {
    const user = userEvent.setup();
    const opml = [
      '<?xml version="1.0"?>',
      '<opml version="2.0"><body><outline text="Tech">',
      '<outline text="One" xmlUrl="https://one.example/feed.xml" />',
      "</outline></body></opml>",
    ].join("");
    const file = new File([opml], "subscriptions.opml", {
      type: "text/x-opml",
    });
    Object.defineProperty(file, "text", {
      configurable: true,
      value: vi.fn().mockResolvedValue(opml),
    });
    renderManagement();

    await user.upload(screen.getByLabelText(/import opml/i), file);

    await waitFor(() => {
      expect(managementMocks.importOpml).toHaveBeenCalledWith({ opml });
    });
  });

  it("exports OPML from a named management action", async () => {
    const user = userEvent.setup();
    renderManagement();

    await user.click(screen.getByRole("button", { name: /export opml/i }));

    await waitFor(() => {
      expect(managementMocks.exportOpml).toHaveBeenCalledTimes(1);
    });
  });

  it("uses a named subscription list with per-item controls in narrow flow order", () => {
    renderManagement();

    const list = screen.getByRole("list", { name: /subscriptions/i });
    const item = within(list).getByText("One Example").closest("li");
    expect(item).not.toBeNull();
    const controls = within(item as HTMLElement);
    expect(
      controls.getByRole("button", { name: /edit one example/i }),
    ).toBeVisible();
    expect(
      controls.getByRole("button", { name: /unsubscribe one example/i }),
    ).toBeVisible();
  });
});
