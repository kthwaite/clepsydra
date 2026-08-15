import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "#/api/schema";

type FeedEntry = components["schemas"]["FeedEntryDto"];

const paneMocks = vi.hoisted(() => ({
  query: {
    data: undefined as FeedEntry | undefined,
    isPending: false,
    isLoading: false,
    isError: false,
    error: null as unknown,
    refetch: vi.fn(),
  },
  useFeedEntry: vi.fn(),
  feedsQuery: {
    data: {
      groups: [
        {
          name: "Engineering",
          feeds: [
            {
              id: 7,
              title: "Manifest Source",
              title_override: "Manifest Ledger",
            },
          ],
        },
      ],
    },
  },
  patchEntryAsync: vi.fn(),
  patchState: {
    isPending: false,
    error: null as unknown,
    reset: vi.fn(),
  },
  copy: vi.fn().mockResolvedValue(undefined),
  copyState: { copied: false },
}));

vi.mock("#/api/feeds", () => ({
  useFeedEntry: (id?: number) => {
    paneMocks.useFeedEntry(id);
    return paneMocks.query;
  },
  useFeeds: () => paneMocks.feedsQuery,
  usePatchFeedEntry: () => ({
    mutateAsync: paneMocks.patchEntryAsync,
    ...paneMocks.patchState,
  }),
}));

vi.mock("#/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({
    copy: paneMocks.copy,
    copied: paneMocks.copyState.copied,
  }),
}));

import {
  FeedReaderPane,
  feedEntryMarkdownLink,
} from "#/components/codex/FeedReaderPane";

const storedEntry: FeedEntry = {
  id: 101,
  feed_id: 7,
  guid: "entry-101",
  title: "Stored dispatch",
  url: "https://source.example/posts/stored",
  author: "Ada Reader",
  content_html: "<p>Sanitized <strong>stored</strong> body.</p>",
  published_at: "2026-08-09T12:00:00Z",
  fetched_at: "2026-08-09T12:01:00Z",
  read: false,
  bookmarked: true,
  tags: ["systems", "reading"],
};

function renderPane(
  selectedEntryId: number | null = 101,
  overrides: Partial<{
    feedName: string | null;
    onBack: () => void;
    onMissing: () => void;
  }> = {},
) {
  return render(
    <FeedReaderPane
      selectedEntryId={selectedEntryId ?? undefined}
      feedName={
        overrides.feedName === null
          ? undefined
          : (overrides.feedName ?? "Source Ledger")
      }
      onBack={overrides.onBack ?? vi.fn()}
      onMissing={overrides.onMissing ?? vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  paneMocks.query.data = storedEntry;
  paneMocks.query.isPending = false;
  paneMocks.query.isLoading = false;
  paneMocks.query.isError = false;
  paneMocks.query.error = null;
  paneMocks.patchState.isPending = false;
  paneMocks.patchState.error = null;
  paneMocks.patchEntryAsync.mockResolvedValue(storedEntry);
  paneMocks.copyState.copied = false;
});

describe("FeedReaderPane", () => {
  it("guides an empty selection without issuing a detail query", () => {
    renderPane(null);

    expect(screen.getByText(/select an entry/i)).toBeVisible();
    expect(paneMocks.useFeedEntry).toHaveBeenCalledWith(undefined);
    expect(paneMocks.query.refetch).not.toHaveBeenCalled();
  });

  it("retains selected identity while pending and through a retryable error", async () => {
    paneMocks.query.data = undefined;
    paneMocks.query.isPending = true;
    paneMocks.query.isLoading = true;
    const page = renderPane();

    expect(screen.getByRole("status")).toHaveTextContent(/entry 101/i);

    paneMocks.query.isPending = false;
    paneMocks.query.isLoading = false;
    paneMocks.query.isError = true;
    paneMocks.query.error = { status: 503, error: "archive unavailable" };
    page.rerender(
      <FeedReaderPane
        selectedEntryId={101}
        feedName="Source Ledger"
        onBack={vi.fn()}
        onMissing={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/entry 101/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/archive unavailable/i);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /retry/i }));
    expect(paneMocks.query.refetch).toHaveBeenCalledTimes(1);
  });

  it("reports a confirmed 404 once and does not expose retry", () => {
    paneMocks.query.data = undefined;
    paneMocks.query.isError = true;
    paneMocks.query.error = { status: 404, error: "entry not found" };
    const onMissing = vi.fn();
    const page = renderPane(101, { onMissing });

    expect(onMissing).toHaveBeenCalledWith(101);
    expect(
      screen.queryByRole("button", { name: /retry/i }),
    ).not.toBeInTheDocument();

    page.rerender(
      <FeedReaderPane
        selectedEntryId={101}
        feedName="Source Ledger"
        onBack={vi.fn()}
        onMissing={onMissing}
      />,
    );
    expect(onMissing).toHaveBeenCalledTimes(1);
  });

  it("renders stored sanitized content and complete entry metadata without an iframe", () => {
    renderPane();

    const article = screen.getByRole("article", { name: "Stored dispatch" });
    expect(article).toHaveTextContent(/sanitized stored body/i);
    expect(within(article).getByText("Manifest Ledger")).toBeVisible();
    expect(within(article).getByText("Ada Reader")).toBeVisible();
    expect(within(article).getByText("#systems")).toBeVisible();
    expect(within(article).getByText("#reading")).toBeVisible();
    expect(within(article).getByText("Unread entry")).toBeVisible();
    expect(within(article).getByText("Saved")).toBeVisible();
    expect(within(article).getByRole("time")).toHaveAttribute(
      "datetime",
      "2026-08-09T12:00:00Z",
    );
    expect(article.querySelector("iframe")).not.toBeInTheDocument();
  });

  it("copies the safe entry as Markdown and shows settled clipboard state", async () => {
    const page = renderPane();

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Copy link" }));
    expect(paneMocks.copy).toHaveBeenCalledWith(
      "[Stored dispatch](https://source.example/posts/stored)",
    );

    paneMocks.copyState.copied = true;
    page.rerender(
      <FeedReaderPane
        selectedEntryId={101}
        feedName="Source Ledger"
        onBack={vi.fn()}
        onMissing={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Copied" })).toBeVisible();
  });

  it("resolves the source label from the loaded entry feed id when no name is supplied", () => {
    renderPane(101, { feedName: null });

    expect(screen.getByText("Manifest Ledger")).toBeVisible();
  });

  it("renders the already-sanitized DTO body as stored", () => {
    paneMocks.query.data = {
      ...storedEntry,
      content_html:
        '<p data-sanitized-source="ammonia">Kept <em>stored</em> text.</p>',
    };
    const page = renderPane();
    const content = page.container.querySelector(".feed-entry-content");

    expect(content?.querySelector("p")).toHaveAttribute(
      "data-sanitized-source",
      "ammonia",
    );
    expect(content).toHaveTextContent("Kept stored text.");
    expect(content?.querySelector("em")).toHaveTextContent("stored");
    expect(content?.querySelector("iframe")).not.toBeInTheDocument();
  });

  it("keeps metadata and offers only a safe HTTP(S) fallback when body is absent", () => {
    paneMocks.query.data = {
      ...storedEntry,
      content_html: null,
      url: "http://source.example/plain",
    };
    const page = renderPane();

    expect(screen.getByText(/no stored body/i)).toBeVisible();
    expect(screen.getByText("Ada Reader")).toBeVisible();
    expect(
      screen.getByRole("link", { name: /open original/i }),
    ).toHaveAttribute("href", "http://source.example/plain");

    paneMocks.query.data = {
      ...storedEntry,
      content_html: null,
      url: "javascript:alert(1)",
    };
    page.rerender(
      <FeedReaderPane
        selectedEntryId={101}
        feedName="Source Ledger"
        onBack={vi.fn()}
        onMissing={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("link", { name: /open original/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /copy link/i }),
    ).not.toBeInTheDocument();
  });

  it("patches read, bookmark, and normalized tags while preserving a failed tag draft", async () => {
    const user = userEvent.setup();
    paneMocks.patchEntryAsync
      .mockResolvedValueOnce({ ...storedEntry, read: true })
      .mockResolvedValueOnce({ ...storedEntry, bookmarked: false })
      .mockRejectedValueOnce(new Error("tags unavailable"));
    renderPane();

    await user.click(screen.getByRole("button", { name: /mark read/i }));
    await user.click(screen.getByRole("button", { name: /unsave/i }));
    await user.click(screen.getByRole("button", { name: /edit tags/i }));
    const input = screen.getByRole("textbox", {
      name: /tags for stored dispatch/i,
    });
    await user.clear(input);
    await user.type(input, " systems, #later, systems ");
    await user.click(screen.getByRole("button", { name: /save tags/i }));

    expect(paneMocks.patchEntryAsync).toHaveBeenNthCalledWith(1, {
      id: 101,
      read: true,
    });
    expect(paneMocks.patchEntryAsync).toHaveBeenNthCalledWith(2, {
      id: 101,
      bookmarked: false,
    });
    expect(paneMocks.patchEntryAsync).toHaveBeenNthCalledWith(3, {
      id: 101,
      tags: ["systems", "later"],
    });
    await waitFor(() =>
      expect(input).toHaveValue(" systems, #later, systems "),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("tags unavailable");
  });

  it("always exposes the supplied back control", async () => {
    const onBack = vi.fn();
    renderPane(101, { onBack });

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Back to entries" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("feedEntryMarkdownLink", () => {
  it("builds safe Markdown entry links with escaped titles and validated URLs", () => {
    expect(
      feedEntryMarkdownLink(
        "Stored dispatch",
        "https://source.example/posts/stored",
      ),
    ).toBe("[Stored dispatch](https://source.example/posts/stored)");
    expect(
      feedEntryMarkdownLink(
        "A [bracket]",
        "http://source.example/plain",
      ),
    ).toBe(String.raw`[A \[bracket\]](http://source.example/plain)`);
    expect(
      feedEntryMarkdownLink(
        String.raw`A \ B`,
        "https://source.example/slash",
      ),
    ).toBe(String.raw`[A \\ B](https://source.example/slash)`);
    expect(feedEntryMarkdownLink("Unsafe", "javascript:alert(1)")).toBeNull();
    expect(feedEntryMarkdownLink("Missing", null)).toBeNull();
  });
});
