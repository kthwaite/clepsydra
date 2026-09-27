import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BaseRenderedMarkdown } from "#/components/bases/BaseRenderedMarkdown";

const {
  openTabMock,
  lookupMock,
  refetchAndLookupMock,
  searchGetMock,
  createMutateAsyncMock,
  toastErrorMock,
} = vi.hoisted(() => ({
  openTabMock: vi.fn(),
  lookupMock: vi.fn<(target: string) => string | null>(),
  refetchAndLookupMock: vi.fn(),
  searchGetMock: vi.fn(),
  createMutateAsyncMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
}));

vi.mock("#/editor/wikilinkResolution", () => ({
  useWikilinkResolution: () => ({
    lookup: lookupMock,
    refetchAndLookup: refetchAndLookupMock,
  }),
}));

vi.mock("#/api/client", () => ({
  fetchClient: { GET: searchGetMock },
}));

vi.mock("#/api/pages", () => ({
  useCreatePage: () => ({ mutateAsync: createMutateAsyncMock }),
}));

vi.mock("sonner", () => ({
  toast: { error: toastErrorMock, success: vi.fn() },
}));

vi.mock("#/api/attachments", () => ({
  attachmentUrl: (path: string) => `/api/vault/attachments/${path}`,
  useAttachments: () => ({ data: [] }),
}));

const RESOLVED: Record<string, string> = {
  "Target Page": "notes/target.md",
  "Target Page#Tasting notes": "notes/target.md",
};

beforeEach(() => {
  openTabMock.mockReset();
  vi.clearAllMocks();
  lookupMock.mockReset();
  refetchAndLookupMock.mockResolvedValue(null);
  searchGetMock.mockResolvedValue({ data: [] });
  lookupMock.mockImplementation((target) => RESOLVED[target] ?? null);
});

describe("BaseRenderedMarkdown wikilinks", () => {
  it("opens the resolved page for a wikilink, not a slugified name", async () => {
    const user = userEvent.setup();
    render(<BaseRenderedMarkdown content="[[Target Page]]" />);

    const link = screen.getByRole("link", { name: "Target Page" });
    expect(link).toHaveAttribute(
      "href",
      `/pages/${encodeURIComponent("notes/target.md")}`,
    );
    expect(lookupMock).toHaveBeenCalledWith("Target Page");

    await user.click(link);
    expect(openTabMock).toHaveBeenCalledWith(
      "page",
      "notes/target.md",
      "Target Page",
    );
    expect(searchGetMock).not.toHaveBeenCalled();
  });

  it("shows an alias but resolves the target", async () => {
    const user = userEvent.setup();
    render(<BaseRenderedMarkdown content="[[Target Page|the target]]" />);

    await user.click(screen.getByRole("link", { name: "the target" }));
    expect(openTabMock).toHaveBeenCalledWith(
      "page",
      "notes/target.md",
      "Target Page",
    );
  });

  it("resolves a heading-anchored link by its raw target, as the editor does", async () => {
    const user = userEvent.setup();
    render(<BaseRenderedMarkdown content="[[Target Page#Tasting notes]]" />);

    await user.click(
      screen.getByRole("link", { name: "Target Page#Tasting notes" }),
    );
    expect(lookupMock).toHaveBeenCalledWith("Target Page#Tasting notes");
    expect(openTabMock).toHaveBeenCalledWith(
      "page",
      "notes/target.md",
      "Target Page",
    );
  });

  function searchReturns(entries: { path: string; title?: string | null }[]) {
    searchGetMock.mockResolvedValue({
      data: entries.map((entry, index) => ({
        page_id: String(index),
        snippet: "",
        ...entry,
      })),
    });
  }

  it("renders an unresolved link as dangling with no href", () => {
    render(<BaseRenderedMarkdown content="[[Missing Page]]" />);

    const link = screen.getByRole("link", { name: "Missing Page" });
    expect(link).not.toHaveAttribute("href");
    expect(link).toHaveClass("italic", "text-mute");
  });

  it("resolves an unresolved link through the provider's refetch first", async () => {
    refetchAndLookupMock.mockResolvedValue("notes/refetched.md");
    const user = userEvent.setup();
    render(<BaseRenderedMarkdown content="[[Missing Page]]" />);

    await user.click(screen.getByRole("link", { name: "Missing Page" }));
    await waitFor(() =>
      expect(openTabMock).toHaveBeenCalledWith(
        "page",
        "notes/refetched.md",
        "Missing Page",
      ),
    );
    expect(searchGetMock).not.toHaveBeenCalled();
  });

  it("resolves an unresolved link by exact title from search", async () => {
    searchReturns([
      { path: "notes/other.md", title: "Other" },
      { path: "notes/real.md", title: "Real  Page" },
    ]);
    const user = userEvent.setup();
    render(<BaseRenderedMarkdown content="[[real page|see it]]" />);

    await user.click(screen.getByRole("link", { name: "see it" }));
    await waitFor(() =>
      expect(openTabMock).toHaveBeenCalledWith(
        "page",
        "notes/real.md",
        "real page",
      ),
    );
  });

  it("resolves an unresolved link by file stem", async () => {
    searchReturns([{ path: "notes/2026/brew-log.md", title: "Brewing" }]);
    const user = userEvent.setup();
    render(<BaseRenderedMarkdown content="[[brew-log]]" />);

    await user.click(screen.getByRole("link", { name: "brew-log" }));
    await waitFor(() =>
      expect(openTabMock).toHaveBeenCalledWith(
        "page",
        "notes/2026/brew-log.md",
        "brew-log",
      ),
    );
  });

  it("resolves an unresolved link by vault path, with or without .md", async () => {
    searchReturns([{ path: "notes/brew-log.md", title: "Brewing" }]);
    const user = userEvent.setup();
    render(
      <BaseRenderedMarkdown content="[[notes/brew-log]] [[notes/brew-log.md]]" />,
    );

    await user.click(screen.getByRole("link", { name: "notes/brew-log" }));
    await waitFor(() => expect(openTabMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("link", { name: "notes/brew-log.md" }));
    await waitFor(() => expect(openTabMock).toHaveBeenCalledTimes(2));
    expect(openTabMock.mock.calls.map((call) => call[1])).toEqual([
      "notes/brew-log.md",
      "notes/brew-log.md",
    ]);
  });

  it("strips a heading anchor before searching and matching", async () => {
    searchReturns([{ path: "notes/real.md", title: "Real Page" }]);
    const user = userEvent.setup();
    render(<BaseRenderedMarkdown content="[[Real Page#Method]]" />);

    await user.click(screen.getByRole("link", { name: "Real Page#Method" }));
    await waitFor(() =>
      expect(openTabMock).toHaveBeenCalledWith(
        "page",
        "notes/real.md",
        "Real Page",
      ),
    );
    expect(searchGetMock).toHaveBeenCalledWith("/api/vault/index/search", {
      params: { query: { q: "Real Page" } },
    });
  });

  it("toasts and neither navigates nor creates when nothing matches", async () => {
    searchReturns([{ path: "notes/near.md", title: "Missing Pages" }]);
    const user = userEvent.setup();
    render(<BaseRenderedMarkdown content="[[Missing Page]]" />);

    await user.click(screen.getByRole("link", { name: "Missing Page" }));
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "No page named “Missing Page”",
      ),
    );
    expect(openTabMock).not.toHaveBeenCalled();
    expect(createMutateAsyncMock).not.toHaveBeenCalled();
  });

  it("toasts and does not navigate when search fails", async () => {
    searchGetMock.mockResolvedValue({ error: { message: "boom" } });
    const user = userEvent.setup();
    render(<BaseRenderedMarkdown content="[[Missing Page]]" />);

    await user.click(screen.getByRole("link", { name: "Missing Page" }));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(openTabMock).not.toHaveBeenCalled();
    expect(createMutateAsyncMock).not.toHaveBeenCalled();
  });

  it("keeps relative .md links resolved from the destination page", async () => {
    const user = userEvent.setup();
    render(
      <BaseRenderedMarkdown
        content="[Source](../notes/source.md)"
        pagePath="reports/tastings.md"
      />,
    );

    const link = screen.getByRole("link", { name: "Source" });
    expect(link).toHaveAttribute(
      "href",
      `/pages/${encodeURIComponent("notes/source.md")}`,
    );
    await user.click(link);
    expect(openTabMock).toHaveBeenCalledWith("page", "notes/source.md");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("keeps external links external", () => {
    render(<BaseRenderedMarkdown content="[Example](https://example.com/a)" />);

    const link = screen.getByRole("link", { name: "Example" });
    expect(link).toHaveAttribute("href", "https://example.com/a");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("does not leak react-markdown's node prop onto anchors", () => {
    const { container } = render(
      <BaseRenderedMarkdown
        content={
          "[[Target Page]] [[Missing Page]] [Local](/pages/notes/local.md) [Ext](https://example.com)"
        }
      />,
    );

    const anchors = container.querySelectorAll("a");
    expect(anchors).toHaveLength(4);
    for (const anchor of anchors) {
      expect(anchor).not.toHaveAttribute("node");
    }
  });
});
