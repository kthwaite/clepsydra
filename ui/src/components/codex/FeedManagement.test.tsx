import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "#/api/schema";
import { feedDisclosureStorageKey } from "#/store/feedDisclosure";

type FeedList = components["schemas"]["FeedListResponse"];
type FeedListWithCounts = FeedList & {
  counts: { unread: number; all: number; saved: number };
};

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

const feedList: FeedListWithCounts = {
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
  preference_namespace: "fixture-feed-preferences",
  counts: { unread: 1, all: 1, saved: 0 },
};

const disclosureFeedList: FeedListWithCounts = {
  ...feedList,
  diagnostics: [],
  groups: [
    feedList.groups[0],
    {
      name: "Research",
      feeds: [
        {
          id: 8,
          title: "Two Example",
          title_override: null,
          url: "https://two.example/feed.xml",
          fetch_url: "https://two.example/feed.xml",
          site_url: "https://two.example",
          group: "Research",
          tags: ["design"],
          last_fetch_at: "2026-08-09T12:15:00Z",
          next_fetch_at: "2026-08-09T13:15:00Z",
          error_count: 0,
          last_error: null,
        },
      ],
    },
  ],
  counts: { unread: 1, all: 2, saved: 0 },
};

function groupDisclosure(name: string) {
  return screen.getByRole("button", {
    name: new RegExp(`${name} group`, "i"),
  });
}

function feedDisclosure(title: string) {
  return screen.getByRole("button", {
    name: new RegExp(`${title} feed`, "i"),
  });
}

function renderManagement() {
  return render(<FeedManagement />);
}

/** The subscribe modal, once its opening transition has settled. */
function subscribeDialog() {
  return screen.findByRole("dialog", { name: /subscribe to a feed/i });
}

function noSubscribeDialog() {
  return (
    screen.queryByRole("dialog", { name: /subscribe to a feed/i }) === null
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FeedManagement", () => {
  it("supports keyboard-only subscription in predictable focus order", async () => {
    const user = userEvent.setup();
    renderManagement();

    await user.tab();
    expect(screen.getByRole("button", { name: /^subscribe$/i })).toHaveFocus();
    await user.keyboard("{Enter}");

    const dialog = await subscribeDialog();
    const url = within(dialog).getByRole("textbox", {
      name: /feed or site url/i,
    });
    await waitFor(() => expect(url).toHaveFocus());
    await user.type(url, "https://one.example/feed");

    await user.tab();
    const group = within(dialog).getByRole("combobox", { name: /^group$/i });
    expect(group).toHaveFocus();
    await user.type(group, "Tech");

    await user.tab();
    expect(
      within(dialog).getByRole("button", { name: /cancel/i }),
    ).toHaveFocus();
    await user.tab();
    expect(
      within(dialog).getByRole("button", { name: /^subscribe$/i }),
    ).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(managementMocks.subscribeFeed).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://one.example/feed",
        group: "Tech",
      }),
    );
  });

  it("keeps subscription in a dialog opened from the Subscriptions header", async () => {
    const user = userEvent.setup();
    renderManagement();

    expect(
      screen.queryByRole("textbox", { name: /feed or site url/i }),
    ).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: /^subscribe$/i });
    const subscriptions = trigger.closest("section");
    expect(subscriptions).not.toBeNull();
    expect(
      within(subscriptions as HTMLElement).getByRole("button", {
        name: /refresh feeds/i,
      }),
    ).toBeVisible();

    await user.click(trigger);
    const dialog = await subscribeDialog();
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(noSubscribeDialog()).toBe(true));
    expect(managementMocks.subscribeFeed).not.toHaveBeenCalled();
  });

  it("offers canonical live-manifest groups in both group comboboxes", async () => {
    managementMocks.feedsQuery.data = {
      ...feedList,
      groups: [
        ...feedList.groups,
        { name: "Research", feeds: [] },
        { name: " research ", feeds: [] },
        { name: "Design", feeds: [] },
      ],
    };
    const user = userEvent.setup();
    renderManagement();

    await user.click(screen.getByRole("button", { name: /^subscribe$/i }));
    const subscribe = await subscribeDialog();
    const subscribeGroup = within(subscribe).getByRole("combobox", {
      name: /^group$/i,
    });
    await user.type(subscribeGroup, "e");
    expect(
      (await screen.findAllByRole("option")).map(
        (option) => option.textContent,
      ),
    ).toEqual(["Engineering", "Research", "Design"]);
    await user.keyboard("{Escape}");
    await user.click(within(subscribe).getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(noSubscribeDialog()).toBe(true));

    await user.click(screen.getByRole("button", { name: /edit one example/i }));
    const dialog = screen.getByRole("dialog", { name: /edit one example/i });
    const editGroup = within(dialog).getByRole("combobox", {
      name: /^group$/i,
    });
    await user.clear(editGroup);
    await user.type(editGroup, "e");
    expect(
      (await screen.findAllByRole("option")).map(
        (option) => option.textContent,
      ),
    ).toEqual(["Engineering", "Research", "Design"]);
  });

  it("submits a selected case-insensitive manifest match once with canonical spelling", async () => {
    const user = userEvent.setup();
    renderManagement();

    await user.click(screen.getByRole("button", { name: /^subscribe$/i }));
    const dialog = await subscribeDialog();
    await user.type(
      within(dialog).getByRole("textbox", { name: /feed or site url/i }),
      "https://canonical.example/feed",
    );
    const group = within(dialog).getByRole("combobox", { name: /^group$/i });
    await user.type(group, "engineering");
    await user.click(
      await screen.findByRole("option", { name: "Engineering" }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: /^subscribe$/i }),
    );

    expect(managementMocks.subscribeFeed).toHaveBeenCalledTimes(1);
    expect(managementMocks.subscribeFeed).toHaveBeenCalledWith({
      url: "https://canonical.example/feed",
      group: "Engineering",
    });
  });

  it("submits a canonical edit selection and a novel edit through the existing mutation", async () => {
    const user = userEvent.setup();
    renderManagement();

    await user.click(screen.getByRole("button", { name: /edit one example/i }));
    let dialog = screen.getByRole("dialog", { name: /edit one example/i });
    let group = within(dialog).getByRole("combobox", { name: /^group$/i });
    await user.clear(group);
    await user.type(group, "engineering");
    await user.click(
      await screen.findByRole("option", { name: "Engineering" }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: /save changes/i }),
    );
    expect(managementMocks.updateFeed).toHaveBeenLastCalledWith({
      id: 7,
      title: null,
      group: "Engineering",
    });

    await user.click(screen.getByRole("button", { name: /edit one example/i }));
    dialog = screen.getByRole("dialog", { name: /edit one example/i });
    group = within(dialog).getByRole("combobox", { name: /^group$/i });
    await user.clear(group);
    await user.type(group, "New Group");
    await user.click(
      within(dialog).getByRole("button", { name: /save changes/i }),
    );
    expect(managementMocks.updateFeed).toHaveBeenLastCalledWith({
      id: 7,
      title: null,
      group: "New Group",
    });
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

  it("keeps subscription setup available for an empty manifest", async () => {
    managementMocks.feedsQuery.data = {
      diagnostics: [],
      groups: [],
      manifest_revision: "empty-revision",
      preference_namespace: "fixture-feed-preferences",
      counts: { unread: 0, all: 0, saved: 0 },
    } satisfies FeedListWithCounts;

    renderManagement();

    expect(screen.getByText(/no subscriptions yet/i)).toBeVisible();
    expect(
      screen.getByText(/subscribe to a feed or import an opml file/i),
    ).toBeVisible();
    const trigger = screen.getByRole("button", { name: /^subscribe$/i });
    expect(trigger).toBeEnabled();

    const user = userEvent.setup();
    await user.click(trigger);
    const dialog = await subscribeDialog();
    expect(
      within(dialog).getByRole("textbox", { name: /feed or site url/i }),
    ).toBeEnabled();
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
    const group = within(dialog).getByRole("combobox", { name: /^group$/i });
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

  it("gives mobile subscription actions 44px targets without changing desktop density", () => {
    renderManagement();

    for (const name of [/edit one example/i, /unsubscribe one example/i]) {
      expect(screen.getByRole("button", { name })).toHaveClass(
        "min-h-11",
        "min-w-11",
        "md:min-h-0",
        "md:min-w-0",
        "h-7",
        "w-7",
        "p-0",
        "[&_svg]:h-4",
        "[&_svg]:w-4",
      );
    }
  });
  it("preserves the full subscribe draft through a conflict and retries once", async () => {
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
    await user.click(screen.getByRole("button", { name: /^subscribe$/i }));
    const dialog = await subscribeDialog();
    const url = within(dialog).getByRole("textbox", {
      name: /feed or site url/i,
    });
    const group = within(dialog).getByRole("combobox", { name: /^group$/i });
    await user.type(url, "https://pending.example/feed");
    await user.type(group, "engineering");
    await user.click(
      await screen.findByRole("option", { name: "Engineering" }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: /^subscribe$/i }),
    );

    managementMocks.subscribeState.isPending = true;
    view.rerender(<FeedManagement />);
    const pending = within(await subscribeDialog());
    expect(pending.getByRole("textbox", { name: /feed or site url/i })).toHaveValue(
      "https://pending.example/feed",
    );
    expect(pending.getByRole("combobox", { name: /^group$/i })).toHaveValue(
      "Engineering",
    );
    expect(
      pending.getByRole("textbox", { name: /feed or site url/i }),
    ).toBeDisabled();
    expect(pending.getByRole("combobox", { name: /^group$/i })).toBeDisabled();
    expect(
      pending.getByRole("button", { name: /^subscribing…?$/i }),
    ).toBeDisabled();

    const failure = new Error("feeds.md changed; reload and retry");
    managementMocks.subscribeState.isPending = false;
    managementMocks.subscribeState.error = failure;
    mutationOptions?.onError?.(failure);
    rejectSubscribe(failure);
    view.rerender(<FeedManagement />);
    const failed = within(await subscribeDialog());
    expect(failed.getByRole("alert")).toHaveTextContent(
      "feeds.md changed; reload and retry",
    );
    expect(failed.getByRole("textbox", { name: /feed or site url/i })).toHaveValue(
      "https://pending.example/feed",
    );
    expect(failed.getByRole("combobox", { name: /^group$/i })).toHaveValue(
      "Engineering",
    );
    managementMocks.subscribeFeedAsync.mockImplementation((variables) => {
      managementMocks.subscribeFeed(variables);
      return Promise.resolve();
    });
    await user.click(failed.getByRole("button", { name: /^subscribe$/i }));
    await waitFor(() =>
      expect(managementMocks.subscribeFeed).toHaveBeenCalledTimes(2),
    );
  });

  it("closes the subscribe dialog and drops its draft only after success", async () => {
    managementMocks.subscribeFeed.mockImplementation((_variables, options) => {
      options?.onSuccess?.();
    });
    managementMocks.subscribeFeedAsync.mockImplementation((variables) => {
      managementMocks.subscribeFeed(variables);
      return Promise.resolve();
    });
    const user = userEvent.setup();
    renderManagement();
    await user.click(screen.getByRole("button", { name: /^subscribe$/i }));
    const dialog = await subscribeDialog();
    await user.type(
      within(dialog).getByRole("textbox", { name: /feed or site url/i }),
      "https://success.example/feed",
    );
    await user.type(
      within(dialog).getByRole("combobox", { name: /^group$/i }),
      "Tech",
    );

    await user.click(
      within(dialog).getByRole("button", { name: /^subscribe$/i }),
    );

    await waitFor(() => expect(noSubscribeDialog()).toBe(true));

    await user.click(screen.getByRole("button", { name: /^subscribe$/i }));
    const reopened = within(await subscribeDialog());
    expect(
      reopened.getByRole("textbox", { name: /feed or site url/i }),
    ).toHaveValue("");
    expect(reopened.getByRole("combobox", { name: /^group$/i })).toHaveValue("");
  });

  it("keeps the full edit draft and local alert through a conflict", async () => {
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
    const group = within(dialog).getByRole("combobox", { name: /^group$/i });
    await user.clear(group);
    await user.type(group, "Conflict Group");
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
      within(dialog).getByRole("combobox", { name: /^group$/i }),
    ).toHaveValue("Conflict Group");
    expect(
      within(dialog).getByRole("combobox", { name: /^group$/i }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: /save changes|saving/i }),
    ).toBeDisabled();

    const failure = new Error("feeds.md changed; reload and retry");
    managementMocks.updateState.isPending = false;
    managementMocks.updateState.error = failure;
    mutationOptions?.onError?.(failure);
    rejectUpdate(failure);
    view.rerender(<FeedManagement />);
    dialog = screen.getByRole("dialog", { name: /edit one example/i });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "feeds.md changed; reload and retry",
    );
    expect(
      within(dialog).getByRole("textbox", { name: /^title$/i }),
    ).toHaveValue("Pending title");
    expect(
      within(dialog).getByRole("combobox", { name: /^group$/i }),
    ).toHaveValue("Conflict Group");
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
  it("starts an absent title override blank and submits a group-only edit as null", async () => {
    const user = userEvent.setup();
    renderManagement();

    await user.click(screen.getByRole("button", { name: /edit one example/i }));
    const dialog = screen.getByRole("dialog", { name: /edit one example/i });
    const title = within(dialog).getByRole("textbox", { name: /^title$/i });
    const group = within(dialog).getByRole("combobox", { name: /^group$/i });
    expect(title).toHaveValue("");

    await user.clear(group);
    await user.type(group, "Research");
    await user.click(
      within(dialog).getByRole("button", { name: /save changes/i }),
    );

    expect(managementMocks.updateFeed).toHaveBeenCalledWith({
      id: 7,
      title: null,
      group: "Research",
    });
  });

  it.each(["success", "failure"] as const)(
    "resets the OPML picker after %s so the same file can be retried",
    async (outcome) => {
      managementMocks.importOpml.mockImplementation(() => {
        if (outcome === "failure") throw new Error("Import failed");
      });
      const user = userEvent.setup();
      const opml = '<?xml version="1.0"?><opml version="2.0"><body /></opml>';
      const file = new File([opml], "subscriptions.opml", {
        type: "text/x-opml",
      });
      Object.defineProperty(file, "text", {
        configurable: true,
        value: vi.fn().mockResolvedValue(opml),
      });
      renderManagement();
      const input = screen.getByLabelText(/import opml/i);

      await user.upload(input, file);
      await waitFor(() =>
        expect(managementMocks.importOpml).toHaveBeenCalledTimes(1),
      );
      expect(input).toHaveValue("");

      await user.upload(input, file);
      await waitFor(() =>
        expect(managementMocks.importOpml).toHaveBeenCalledTimes(2),
      );
      expect(managementMocks.importOpml).toHaveBeenLastCalledWith({ opml });
      expect(input).toHaveValue("");
    },
  );

  it("starts every group and feed expanded when storage is absent", async () => {
    managementMocks.feedsQuery.data = disclosureFeedList;

    renderManagement();

    await waitFor(() => {
      expect(groupDisclosure("Engineering")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });
    expect(groupDisclosure("Research")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(feedDisclosure("One Example")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(feedDisclosure("Two Example")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("operates group and feed disclosures by pointer, Enter, and Space", async () => {
    managementMocks.feedsQuery.data = disclosureFeedList;
    const user = userEvent.setup();
    renderManagement();

    const group = groupDisclosure("Engineering");
    await user.click(group);
    expect(group).toHaveAttribute("aria-expanded", "false");
    await user.click(group);
    expect(group).toHaveAttribute("aria-expanded", "true");
    group.focus();
    await user.keyboard("{Enter}");
    expect(group).toHaveAttribute("aria-expanded", "false");
    await user.keyboard(" ");
    expect(group).toHaveAttribute("aria-expanded", "true");

    const feed = feedDisclosure("One Example");
    await user.click(feed);
    expect(feed).toHaveAttribute("aria-expanded", "false");
    await user.click(feed);
    expect(feed).toHaveAttribute("aria-expanded", "true");
    feed.focus();
    await user.keyboard(" ");
    expect(feed).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{Enter}");
    expect(feed).toHaveAttribute("aria-expanded", "true");
  });

  it("hides a collapsed group without discarding its nested feed preference", async () => {
    managementMocks.feedsQuery.data = disclosureFeedList;
    const user = userEvent.setup();
    renderManagement();

    await user.click(feedDisclosure("One Example"));
    expect(feedDisclosure("One Example")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await user.click(groupDisclosure("Engineering"));

    expect(
      screen.queryByRole("list", { name: /engineering feeds/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /one example feed/i }),
    ).not.toBeInTheDocument();

    await user.click(groupDisclosure("Engineering"));

    expect(
      screen.getByRole("list", { name: /engineering feeds/i }),
    ).toBeVisible();
    expect(feedDisclosure("One Example")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("restores collapsed state on remount only for the same namespace", async () => {
    managementMocks.feedsQuery.data = disclosureFeedList;
    const user = userEvent.setup();
    const first = renderManagement();

    await user.click(groupDisclosure("Research"));
    await user.click(feedDisclosure("One Example"));
    first.unmount();

    const second = renderManagement();
    await waitFor(() => {
      expect(groupDisclosure("Research")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });
    expect(feedDisclosure("One Example")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    second.unmount();

    managementMocks.feedsQuery.data = {
      ...disclosureFeedList,
      preference_namespace: "another-vault",
    };
    renderManagement();

    await waitFor(() => {
      expect(groupDisclosure("Research")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });
    expect(feedDisclosure("One Example")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("prunes obsolete preferences after each successful manifest", async () => {
    const key = feedDisclosureStorageKey(
      disclosureFeedList.preference_namespace,
    );
    window.localStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        groups: ["engineering", "research", "obsolete"],
        feeds: [7, 8, 99],
      }),
    );
    managementMocks.feedsQuery.data = disclosureFeedList;
    const view = renderManagement();

    await waitFor(() => {
      expect(JSON.parse(window.localStorage.getItem(key) ?? "{}")).toEqual({
        version: 1,
        groups: ["engineering", "research"],
        feeds: [7, 8],
      });
    });

    managementMocks.feedsQuery.data = {
      ...disclosureFeedList,
      groups: disclosureFeedList.groups.slice(0, 1),
      counts: { unread: 1, all: 1, saved: 0 },
    };
    view.rerender(<FeedManagement />);

    await waitFor(() => {
      expect(JSON.parse(window.localStorage.getItem(key) ?? "{}")).toEqual({
        version: 1,
        groups: ["engineering"],
        feeds: [7],
      });
    });
  });

  it("does not prune stored preferences while the manifest loads or errors", () => {
    const key = feedDisclosureStorageKey(
      disclosureFeedList.preference_namespace,
    );
    const stored = JSON.stringify({
      version: 1,
      groups: ["possibly-live"],
      feeds: [44],
    });
    window.localStorage.setItem(key, stored);
    managementMocks.feedsQuery.data = undefined;
    managementMocks.feedsQuery.isPending = true;
    managementMocks.feedsQuery.isLoading = true;
    const view = renderManagement();

    expect(window.localStorage.getItem(key)).toBe(stored);

    managementMocks.feedsQuery.isPending = false;
    managementMocks.feedsQuery.isLoading = false;
    managementMocks.feedsQuery.isError = true;
    managementMocks.feedsQuery.error = new Error("manifest unavailable");
    view.rerender(<FeedManagement />);

    expect(window.localStorage.getItem(key)).toBe(stored);
  });

  it("keeps summary metadata and actions visible in compact collapsed rows", async () => {
    managementMocks.feedsQuery.data = disclosureFeedList;
    const user = userEvent.setup();
    renderManagement();

    await user.click(feedDisclosure("One Example"));
    const item = screen.getByText("One Example").closest("li");
    expect(item).not.toBeNull();
    const collapsed = within(item as HTMLElement);

    expect(collapsed.getByText("One Example")).toBeVisible();
    expect(collapsed.getByText("https://one.example/feed.xml")).toBeVisible();
    expect(collapsed.getByLabelText(/degraded feed health/i)).toBeVisible();
    expect(collapsed.getByText(/last fetch/i)).toBeVisible();
    expect(collapsed.getByText(/next fetch/i)).toBeVisible();
    expect(collapsed.getByText(/2 errors/i)).toBeVisible();
    expect(collapsed.getByText("#rust")).toBeVisible();
    expect(collapsed.getByText("#systems")).toBeVisible();
    expect(
      collapsed.getByRole("button", { name: /edit one example/i }),
    ).toBeVisible();
    expect(
      collapsed.getByRole("button", { name: /unsubscribe one example/i }),
    ).toBeVisible();
    expect(
      collapsed.queryByText("Timeout contacting origin"),
    ).not.toBeVisible();

    await user.click(feedDisclosure("One Example"));

    expect(
      collapsed.getByRole("button", { name: /edit one example/i }),
    ).toBeVisible();
    expect(
      collapsed.getByRole("button", { name: /unsubscribe one example/i }),
    ).toBeVisible();
    expect(collapsed.getByText("Timeout contacting origin")).toBeVisible();
  });

  it("persists one committed transition once under StrictMode", async () => {
    managementMocks.feedsQuery.data = disclosureFeedList;
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    render(
      <StrictMode>
        <FeedManagement />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(feedDisclosure("One Example")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });
    expect(setItem).not.toHaveBeenCalled();

    await user.click(feedDisclosure("One Example"));

    expect(feedDisclosure("One Example")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await waitFor(() => expect(setItem).toHaveBeenCalledTimes(1));
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it.each(["loading", "error"] as const)(
    "keeps retained-data disclosures interactive during background %s without pruning",
    async (queryState) => {
      const key = feedDisclosureStorageKey(
        disclosureFeedList.preference_namespace,
      );
      window.localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          groups: ["research", "obsolete"],
          feeds: [8, 99],
        }),
      );
      managementMocks.feedsQuery.data = disclosureFeedList;
      if (queryState === "loading") {
        managementMocks.feedsQuery.isPending = true;
        managementMocks.feedsQuery.isLoading = true;
      } else {
        managementMocks.feedsQuery.isError = true;
        managementMocks.feedsQuery.error = new Error(
          "background refresh failed",
        );
      }
      const user = userEvent.setup();
      renderManagement();

      await waitFor(() => {
        expect(groupDisclosure("Research")).toHaveAttribute(
          "aria-expanded",
          "false",
        );
      });
      const engineering = groupDisclosure("Engineering");
      await user.click(engineering);
      expect(engineering).toHaveAttribute("aria-expanded", "false");
      await user.click(engineering);
      expect(engineering).toHaveAttribute("aria-expanded", "true");

      const feed = feedDisclosure("One Example");
      feed.focus();
      await user.keyboard(" ");
      expect(feed).toHaveAttribute("aria-expanded", "false");
      expect(JSON.parse(window.localStorage.getItem(key) ?? "{}")).toEqual({
        version: 1,
        groups: ["obsolete", "research"],
        feeds: [7, 8, 99],
      });
    },
  );

  it("restores distinct preferences across a same-mounted A to B to A namespace switch", async () => {
    const namespaceA = disclosureFeedList.preference_namespace;
    const namespaceB = "another-vault";
    window.localStorage.setItem(
      feedDisclosureStorageKey(namespaceA),
      JSON.stringify({
        version: 1,
        groups: ["engineering"],
        feeds: [8],
      }),
    );
    window.localStorage.setItem(
      feedDisclosureStorageKey(namespaceB),
      JSON.stringify({
        version: 1,
        groups: ["research"],
        feeds: [7],
      }),
    );
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    managementMocks.feedsQuery.data = disclosureFeedList;
    const view = renderManagement();

    await waitFor(() => {
      expect(groupDisclosure("Engineering")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });
    expect(groupDisclosure("Research")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(feedDisclosure("Two Example")).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    managementMocks.feedsQuery.data = {
      ...disclosureFeedList,
      preference_namespace: namespaceB,
    };
    view.rerender(<FeedManagement />);

    await waitFor(() => {
      expect(groupDisclosure("Research")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });
    expect(groupDisclosure("Engineering")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(feedDisclosure("One Example")).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    managementMocks.feedsQuery.data = disclosureFeedList;
    view.rerender(<FeedManagement />);

    await waitFor(() => {
      expect(groupDisclosure("Engineering")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });
    expect(groupDisclosure("Research")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(feedDisclosure("Two Example")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(setItem).not.toHaveBeenCalled();
  });
});
