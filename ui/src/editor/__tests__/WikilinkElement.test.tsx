import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { RenderElementProps } from "slate-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WikilinkElement as WikilinkElementType } from "#/editor/types";

type CapturedCLinkProps = {
  path?: string;
  onClick?: (e: unknown) => void;
  className?: string;
  children?: ReactNode;
};

const {
  lookupMock,
  refetchAndLookupMock,
  openTabMock,
  createMutateAsyncMock,
  searchGetMock,
  clinkCalls,
} = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  refetchAndLookupMock: vi.fn(),
  openTabMock: vi.fn(),
  createMutateAsyncMock: vi.fn(),
  searchGetMock: vi.fn(),
  clinkCalls: [] as Array<{
    path?: string;
    onClick?: (e: unknown) => void;
    className?: string;
    children?: unknown;
  }>,
}));

vi.mock("#/editor/wikilinkResolution", () => ({
  useWikilinkResolution: () => ({
    lookup: lookupMock,
    refetchAndLookup: refetchAndLookupMock,
  }),
}));
vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
}));
vi.mock("#/api/pages", () => ({
  // TanStack mutation results are unstable per render — return a fresh object
  // on every call; only mutateAsync identity is stable.
  useCreatePage: () => ({
    mutateAsync: createMutateAsyncMock,
    isPending: false,
  }),
}));
vi.mock("#/api/client", () => ({
  fetchClient: { GET: searchGetMock },
}));
vi.mock("#/components/codex/CLink", () => ({
  CLink: (props: CapturedCLinkProps) => {
    clinkCalls.push(props);
    return (
      <span
        role="link"
        tabIndex={0}
        className={props.className}
        onClick={props.onClick}
        onKeyDown={() => {}}
      >
        {props.children}
      </span>
    );
  },
}));

import { WikilinkElement } from "#/editor/elements/WikilinkElement";

const attributes = {
  "data-slate-node": "element",
  "data-slate-inline": true,
  "data-slate-void": true,
  ref: () => {},
} as unknown as RenderElementProps["attributes"];

function renderWikilink(target: string, alias?: string) {
  const element: WikilinkElementType = {
    type: "wikilink",
    target,
    alias,
    children: [{ text: "" }],
  };
  return render(
    <WikilinkElement attributes={attributes} element={element}>
      {null}
    </WikilinkElement>,
  );
}

function lastCLink() {
  const props = clinkCalls[clinkCalls.length - 1];
  expect(props).toBeDefined();
  return props;
}

function searchEntry(path: string, title: string | null) {
  return {
    page_id: "0195e9aa-0000-7000-8000-000000000001",
    path,
    snippet: "",
    title,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clinkCalls.length = 0;
  lookupMock.mockReturnValue(null);
  refetchAndLookupMock.mockResolvedValue(null);
  searchGetMock.mockResolvedValue({ data: [] });
  createMutateAsyncMock.mockResolvedValue({});
});

describe("WikilinkElement resolved", () => {
  it("passes the resolved vault path to CLink, not the raw target", () => {
    lookupMock.mockReturnValue("notes/clepsydra-design.md");
    renderWikilink("Clepsydra Design Notes");

    expect(lookupMock).toHaveBeenCalledWith("Clepsydra Design Notes");
    const clink = lastCLink();
    expect(clink.path).toBe("notes/clepsydra-design.md");
    expect(clink.onClick).toBeUndefined();
  });

  it("keeps the standard styling without dangling classes", () => {
    lookupMock.mockReturnValue("notes/clepsydra-design.md");
    renderWikilink("Clepsydra Design Notes");

    const link = screen.getByRole("link");
    expect(link.className).not.toContain("decoration-dashed");
    expect(link.className).not.toContain("text-ink-mute");
    expect(link.className).toContain("text-ink");
  });

  it("shows only the alias when a custom label exists", () => {
    lookupMock.mockReturnValue("notes/clepsydra-design.md");
    renderWikilink("Clepsydra Design Notes", "the design doc");

    expect(screen.getByText("the design doc")).toBeInTheDocument();
    expect(screen.queryByText("Clepsydra Design Notes")).toBeNull();
  });

  it("shows the target when no custom label exists", () => {
    lookupMock.mockReturnValue("notes/clepsydra-design.md");
    renderWikilink("Clepsydra Design Notes");

    expect(screen.getByText("Clepsydra Design Notes")).toBeInTheDocument();
  });
});

describe("WikilinkElement dangling", () => {
  it("renders muted dashed styling and passes no path to CLink", () => {
    renderWikilink("Unwritten Page");

    const clink = lastCLink();
    expect(clink.path).toBeUndefined();
    expect(typeof clink.onClick).toBe("function");

    const link = screen.getByRole("link");
    expect(link.className).toContain("text-ink-mute");
    expect(link.className).toContain("decoration-dashed");
  });

  it("shows only the alias for a dangling labeled link", () => {
    renderWikilink("Unwritten Page", "someday");

    expect(screen.getByText("someday")).toBeInTheDocument();
    expect(screen.queryByText("Unwritten Page")).toBeNull();
  });
});

describe("WikilinkElement dangling click", () => {
  it("opens the tab at the refreshed path on a refetch hit, without search or create", async () => {
    const user = userEvent.setup();
    refetchAndLookupMock.mockResolvedValue("notes/refreshed.md");
    renderWikilink("Late Indexed Page");

    await user.click(screen.getByRole("link"));

    await waitFor(() =>
      expect(openTabMock).toHaveBeenCalledWith("page", "notes/refreshed.md"),
    );
    expect(refetchAndLookupMock).toHaveBeenCalledWith("Late Indexed Page");
    expect(searchGetMock).not.toHaveBeenCalled();
    expect(createMutateAsyncMock).not.toHaveBeenCalled();
  });

  it("opens a case-insensitive exact-title search match instead of creating", async () => {
    const user = userEvent.setup();
    searchGetMock.mockResolvedValue({
      data: [
        searchEntry("notes/decoy.md", "Something Else Entirely"),
        searchEntry("notes/untitled.md", null),
        searchEntry("notes/existing.md", "clepsydra design notes"),
      ],
    });
    renderWikilink("Clepsydra Design Notes");

    await user.click(screen.getByRole("link"));

    await waitFor(() =>
      expect(openTabMock).toHaveBeenCalledWith("page", "notes/existing.md"),
    );
    expect(searchGetMock).toHaveBeenCalledWith("/api/vault/index/search", {
      params: { query: { q: "Clepsydra Design Notes" } },
    });
    expect(createMutateAsyncMock).not.toHaveBeenCalled();
  });

  it("matches search titles after NFC normalization", async () => {
    const user = userEvent.setup();
    // Target uses precomposed é; the index returns decomposed e + ́.
    searchGetMock.mockResolvedValue({
      data: [searchEntry("notes/cafe.md", "Cafe\u{301} Notes")],
    });
    renderWikilink("Caf\u{e9} Notes");

    await user.click(screen.getByRole("link"));

    await waitFor(() =>
      expect(openTabMock).toHaveBeenCalledWith("page", "notes/cafe.md"),
    );
    expect(createMutateAsyncMock).not.toHaveBeenCalled();
  });

  it("creates the page at the intake-derived path on a full miss, then opens it", async () => {
    const user = userEvent.setup();
    searchGetMock.mockResolvedValue({
      data: [
        searchEntry("notes/near-miss.md", "Clepsydra Design Notes Extended"),
      ],
    });
    renderWikilink("Clepsydra Design Notes");

    await user.click(screen.getByRole("link"));

    await waitFor(() => expect(openTabMock).toHaveBeenCalledTimes(1));
    expect(createMutateAsyncMock).toHaveBeenCalledTimes(1);
    const [vars] = createMutateAsyncMock.mock.calls[0];
    expect(vars.body).toEqual({ title: "Clepsydra Design Notes" });
    const derivedPath = vars.params.path.path;
    expect(derivedPath).toMatch(
      /^notes\/\d{8}\.clepsydra-design-notes\.[0-9A-Za-z]{8}\.md$/,
    );
    expect(openTabMock).toHaveBeenCalledWith("page", derivedPath);
  });

  it("ignores clicks while a previous dangling-click flow is in flight", async () => {
    const user = userEvent.setup();
    let resolveRefetch: (value: string | null) => void = () => {};
    refetchAndLookupMock.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolveRefetch = resolve;
        }),
    );
    renderWikilink("Unwritten Page");
    const link = screen.getByRole("link");

    await user.click(link);
    await user.click(link);
    expect(refetchAndLookupMock).toHaveBeenCalledTimes(1);

    resolveRefetch("notes/finally.md");
    await waitFor(() => expect(openTabMock).toHaveBeenCalledTimes(1));
    expect(openTabMock).toHaveBeenCalledWith("page", "notes/finally.md");

    // Once the flow settles, a new click starts a fresh flow.
    await user.click(link);
    expect(refetchAndLookupMock).toHaveBeenCalledTimes(2);
    resolveRefetch("notes/finally.md");
    await waitFor(() => expect(openTabMock).toHaveBeenCalledTimes(2));
  });
});
