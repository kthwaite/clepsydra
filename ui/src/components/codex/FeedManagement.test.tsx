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
  subscribeFeedAsync: vi.fn(),
  subscribeState: {
    isPending: false,
    error: null as Error | null,
    reset: vi.fn(),
  },
  updateFeed: vi.fn(),
  updateFeedAsync: vi.fn(),
  updateState: {
    isPending: false,
    error: null as Error | null,
    reset: vi.fn(),
  },
  deleteFeed: vi.fn(),
  deleteFeedAsync: vi.fn(),
  deleteState: {
    isPending: false,
    error: null as Error | null,
    reset: vi.fn(),
  },
  refreshFeeds: vi.fn(),
  refreshState: {
    isPending: false,
    error: null as Error | null,
    reset: vi.fn(),
  },
  importOpml: vi.fn(),
  importState: {
    isPending: false,
    error: null as Error | null,
    reset: vi.fn(),
  },
  exportOpml: vi.fn(),
}));

vi.mock("#/api/feeds", () => ({
  useFeeds: () => managementMocks.feedsQuery,
  useSubscribeFeed: () => ({
    mutate: managementMocks.subscribeFeed,
    mutateAsync: managementMocks.subscribeFeedAsync,
    ...managementMocks.subscribeState,
  }),
  useUpdateFeed: () => ({
    mutate: managementMocks.updateFeed,
    mutateAsync: managementMocks.updateFeedAsync,
    ...managementMocks.updateState,
  }),
  useDeleteFeed: () => ({
    mutate: managementMocks.deleteFeed,
    mutateAsync: managementMocks.deleteFeedAsync,
    ...managementMocks.deleteState,
  }),
  useRefreshFeeds: () => ({
    mutate: managementMocks.refreshFeeds,
    mutateAsync: managementMocks.refreshFeeds,
    ...managementMocks.refreshState,
  }),
  useImportOpml: () => ({
    mutate: managementMocks.importOpml,
    mutateAsync: managementMocks.importOpml,
    ...managementMocks.importState,
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
  managementMocks.subscribeState.isPending = false;
  managementMocks.subscribeState.error = null;
  managementMocks.updateState.isPending = false;
  managementMocks.updateState.error = null;
  managementMocks.deleteState.isPending = false;
  managementMocks.deleteState.error = null;
  managementMocks.refreshState.isPending = false;
  managementMocks.refreshState.error = null;
  managementMocks.importState.isPending = false;
  managementMocks.importState.error = null;
  managementMocks.subscribeFeedAsync.mockImplementation((variables) => {
    managementMocks.subscribeFeed(variables);
    return Promise.resolve();
  });
  managementMocks.updateFeedAsync.mockImplementation((variables) => {
    managementMocks.updateFeed(variables);
    return Promise.resolve();
  });
  managementMocks.deleteFeedAsync.mockImplementation((variables) => {
    managementMocks.deleteFeed(variables);
    return Promise.resolve();
  });
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
  it("keeps the subscribe draft in its form while pending and after failure", async () => {
    let rejectSubscribe!: (error: Error) => void;
    let mutationOptions:
      | { onError?: (error: Error) => void; onSuccess?: () => void }
      | undefined;
    const pendingSubscribe = new Promise<void>((_resolve, reject) => {
      rejectSubscribe = reject;
    });
    void pendingSubscribe.catch(() => undefined);
    managementMocks.subscribeFeed.mockImplementation((_variables, options) => {
      mutationOptions = options;
    });
    managementMocks.subscribeFeedAsync.mockImplementation((variables) => {
      managementMocks.subscribeFeed(variables);
      return pendingSubscribe;
    });
    const user = userEvent.setup();
    const view = renderManagement();
    const url = screen.getByRole("textbox", { name: /feed or site url/i });
    const group = screen.getByRole("textbox", { name: /^group$/i });
    await user.type(url, "https://pending.example/feed");
    await user.type(group, "Research");
    await user.click(screen.getByRole("button", { name: /^subscribe$/i }));

    managementMocks.subscribeState.isPending = true;
    view.rerender(<FeedManagement />);
    expect(
      screen.getByRole("textbox", { name: /feed or site url/i }),
    ).toHaveValue("https://pending.example/feed");
    expect(screen.getByRole("textbox", { name: /^group$/i })).toHaveValue(
      "Research",
    );
    expect(
      screen.getByRole("textbox", { name: /feed or site url/i }),
    ).toBeDisabled();
    expect(screen.getByRole("textbox", { name: /^group$/i })).toBeDisabled();
    const pendingForm = screen
      .getByRole("textbox", { name: /feed or site url/i })
      .closest("form");
    expect(pendingForm).not.toBeNull();
    expect(
      within(pendingForm as HTMLElement).getByRole("button", {
        name: /^subscribing…?$/i,
      }),
    ).toBeDisabled();

    const failure = new Error("Subscription could not be saved");
    managementMocks.subscribeState.isPending = false;
    managementMocks.subscribeState.error = failure;
    mutationOptions?.onError?.(failure);
    rejectSubscribe(failure);
    view.rerender(<FeedManagement />);
    const form = screen
      .getByRole("textbox", { name: /feed or site url/i })
      .closest("form");
    expect(form).not.toBeNull();
    expect(within(form as HTMLElement).getByRole("alert")).toHaveTextContent(
      "Subscription could not be saved",
    );
    expect(
      screen.getByRole("textbox", { name: /feed or site url/i }),
    ).toHaveValue("https://pending.example/feed");
    expect(screen.getByRole("textbox", { name: /^group$/i })).toHaveValue(
      "Research",
    );
  });

  it("clears the subscribe draft only after mutation success", async () => {
    managementMocks.subscribeFeed.mockImplementation((_variables, options) => {
      options?.onSuccess?.();
    });
    managementMocks.subscribeFeedAsync.mockImplementation((variables) => {
      managementMocks.subscribeFeed(variables);
      return Promise.resolve();
    });
    const user = userEvent.setup();
    renderManagement();
    await user.type(
      screen.getByRole("textbox", { name: /feed or site url/i }),
      "https://success.example/feed",
    );
    await user.type(screen.getByRole("textbox", { name: /^group$/i }), "Tech");

    await user.click(screen.getByRole("button", { name: /^subscribe$/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("textbox", { name: /feed or site url/i }),
      ).toHaveValue("");
      expect(screen.getByRole("textbox", { name: /^group$/i })).toHaveValue("");
    });
  });

  it("keeps the edit dialog, pending controls, draft, and local error until success", async () => {
    let rejectUpdate!: (error: Error) => void;
    let mutationOptions:
      | { onError?: (error: Error) => void; onSuccess?: () => void }
      | undefined;
    const pendingUpdate = new Promise<void>((_resolve, reject) => {
      rejectUpdate = reject;
    });
    void pendingUpdate.catch(() => undefined);
    managementMocks.updateFeed.mockImplementation((_variables, options) => {
      mutationOptions = options;
    });
    managementMocks.updateFeedAsync.mockImplementation((variables) => {
      managementMocks.updateFeed(variables);
      return pendingUpdate;
    });
    const user = userEvent.setup();
    const view = renderManagement();
    await user.click(screen.getByRole("button", { name: /edit one example/i }));
    let dialog = screen.getByRole("dialog", { name: /edit one example/i });
    const title = within(dialog).getByRole("textbox", { name: /^title$/i });
    await user.clear(title);
    await user.type(title, "Pending title");
    await user.click(
      within(dialog).getByRole("button", { name: /save changes/i }),
    );

    managementMocks.updateState.isPending = true;
    view.rerender(<FeedManagement />);
    dialog = screen.getByRole("dialog", { name: /edit one example/i });
    expect(
      within(dialog).getByRole("textbox", { name: /^title$/i }),
    ).toHaveValue("Pending title");
    expect(
      within(dialog).getByRole("textbox", { name: /^title$/i }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: /save changes|saving/i }),
    ).toBeDisabled();

    const failure = new Error("Edit could not be saved");
    managementMocks.updateState.isPending = false;
    managementMocks.updateState.error = failure;
    mutationOptions?.onError?.(failure);
    rejectUpdate(failure);
    view.rerender(<FeedManagement />);
    dialog = screen.getByRole("dialog", { name: /edit one example/i });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Edit could not be saved",
    );
    expect(
      within(dialog).getByRole("textbox", { name: /^title$/i }),
    ).toHaveValue("Pending title");
  });

  it("keeps unsubscribe confirmation open and local while pending or failed", async () => {
    let rejectDelete!: (error: Error) => void;
    let mutationOptions:
      | { onError?: (error: Error) => void; onSuccess?: () => void }
      | undefined;
    const pendingDelete = new Promise<void>((_resolve, reject) => {
      rejectDelete = reject;
    });
    void pendingDelete.catch(() => undefined);
    managementMocks.deleteFeed.mockImplementation((_variables, options) => {
      mutationOptions = options;
    });
    managementMocks.deleteFeedAsync.mockImplementation((variables) => {
      managementMocks.deleteFeed(variables);
      return pendingDelete;
    });
    const user = userEvent.setup();
    const view = renderManagement();
    await user.click(
      screen.getByRole("button", { name: /unsubscribe one example/i }),
    );
    let dialog = screen.getByRole("dialog", {
      name: /unsubscribe one example/i,
    });
    await user.click(
      within(dialog).getByRole("button", { name: /confirm unsubscribe/i }),
    );

    managementMocks.deleteState.isPending = true;
    view.rerender(<FeedManagement />);
    dialog = screen.getByRole("dialog", { name: /unsubscribe one example/i });
    expect(
      within(dialog).getByRole("button", {
        name: /confirm unsubscribe|unsubscribing/i,
      }),
    ).toBeDisabled();

    const failure = new Error("Unsubscribe failed");
    managementMocks.deleteState.isPending = false;
    managementMocks.deleteState.error = failure;
    mutationOptions?.onError?.(failure);
    rejectDelete(failure);
    view.rerender(<FeedManagement />);
    dialog = screen.getByRole("dialog", { name: /unsubscribe one example/i });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Unsubscribe failed",
    );
  });

  it("closes edit and unsubscribe dialogs after their mutations succeed", async () => {
    managementMocks.updateFeed.mockImplementation((_variables, options) => {
      options?.onSuccess?.();
    });
    managementMocks.deleteFeed.mockImplementation((_variables, options) => {
      options?.onSuccess?.();
    });
    managementMocks.updateFeedAsync.mockImplementation((variables) => {
      managementMocks.updateFeed(variables);
      return Promise.resolve();
    });
    managementMocks.deleteFeedAsync.mockImplementation((variables) => {
      managementMocks.deleteFeed(variables);
      return Promise.resolve();
    });
    const user = userEvent.setup();
    renderManagement();
    await user.click(screen.getByRole("button", { name: /edit one example/i }));
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: /edit one example/i }),
      ).toBeNull();
    });

    await user.click(
      screen.getByRole("button", { name: /unsubscribe one example/i }),
    );
    await user.click(
      screen.getByRole("button", { name: /confirm unsubscribe/i }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: /unsubscribe one example/i }),
      ).toBeNull();
    });
  });
});
