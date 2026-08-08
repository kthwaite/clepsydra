import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { createEditor, type Descendant } from "slate";
import { Editable, type RenderElementProps, Slate, withReact } from "slate-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WikilinkElement as WikilinkElementType } from "#/editor/types";
import { withSchema } from "#/editor/schema/withSchema";
import type * as WikilinkEditingExports from "#/editor/wikilinkEditing";
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
  beginMock,
  commitMock,
  cancelMock,
  editingController,
  clinkCalls,
} = vi.hoisted(() => {
  const begin = vi.fn();
  const commit = vi.fn();
  const cancel = vi.fn();
  return {
    lookupMock: vi.fn(),
    refetchAndLookupMock: vi.fn(),
    openTabMock: vi.fn(),
    createMutateAsyncMock: vi.fn(),
    searchGetMock: vi.fn(),
    beginMock: begin,
    commitMock: commit,
    cancelMock: cancel,
    editingController: {
      active: null as {
        path: number[];
        initialCaret: "start" | "end";
        returnSide: "before" | "after";
      } | null,
      begin,
      commit,
      cancel,
    },
    clinkCalls: [] as Array<{
      path?: string;
      onClick?: (e: unknown) => void;
      className?: string;
      children?: unknown;
    }>,
  };
});

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
vi.mock("#/editor/wikilinkEditing", async (importOriginal) => {
  const actual = await importOriginal<typeof WikilinkEditingExports>();
  return {
    ...actual,
    useWikilinkEditing: () => editingController,
  };
});
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

function renderWikilink(
  target: string,
  alias?: string,
  { active = false }: { active?: boolean } = {},
) {
  const editor = withReact(withSchema(createEditor()));
  const element: WikilinkElementType = {
    type: "wikilink",
    target,
    alias,
    children: [{ text: "" }],
  };
  const value: Descendant[] = [
    {
      type: "paragraph",
      children: [{ text: "" }, element, { text: "" }],
    },
  ];
  editingController.active = active
    ? { path: [0, 1], initialCaret: "end", returnSide: "after" }
    : null;
  const renderElement = (props: RenderElementProps) =>
    props.element.type === "wikilink" ? (
      <WikilinkElement
        {...props}
        element={props.element as WikilinkElementType}
      />
    ) : (
      <p {...props.attributes}>{props.children}</p>
    );
  const result = render(
    <Slate editor={editor} initialValue={value}>
      <Editable renderElement={renderElement} />
    </Slate>,
  );
  return { ...result, editor, element };
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
  editingController.active = null;
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
    expect(typeof clink.onClick).toBe("function");
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

describe("WikilinkElement editing and navigation", () => {
  it("begins inline editing on plain click without navigating", () => {
    lookupMock.mockReturnValue("notes/target.md");
    renderWikilink("Target");

    fireEvent.click(screen.getByRole("link"));

    expect(beginMock).toHaveBeenCalledWith([0, 1], "end", "after");
    expect(openTabMock).not.toHaveBeenCalled();
    expect(refetchAndLookupMock).not.toHaveBeenCalled();
    expect(searchGetMock).not.toHaveBeenCalled();
    expect(createMutateAsyncMock).not.toHaveBeenCalled();
  });

  it.each([
    ["Cmd", { metaKey: true }],
    ["Ctrl", { ctrlKey: true }],
  ])(
    "opens a resolved target on %s-click without beginning editing",
    (_modifier, eventInit) => {
      lookupMock.mockReturnValue("notes/target.md");
      renderWikilink("Target");

      fireEvent.click(screen.getByRole("link"), eventInit);

      expect(openTabMock).toHaveBeenCalledWith("page", "notes/target.md");
      expect(beginMock).not.toHaveBeenCalled();
      expect(refetchAndLookupMock).not.toHaveBeenCalled();
      expect(searchGetMock).not.toHaveBeenCalled();
      expect(createMutateAsyncMock).not.toHaveBeenCalled();
    },
  );

  it("renders the active draft as an inline textbox instead of a passive link", () => {
    lookupMock.mockReturnValue("notes/target.md");
    renderWikilink("Target", "Label", { active: true });

    expect(screen.getByRole("textbox", { name: "Edit wikilink" })).toHaveValue(
      "Target|Label",
    );
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("delegates an active commit to the editing controller", async () => {
    const user = userEvent.setup();
    renderWikilink("Target", "Label", { active: true });

    await user.keyboard("{Enter}");

    expect(commitMock).toHaveBeenCalledWith(
      { target: "Target", alias: "Label" },
      "after",
    );
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("delegates an active cancel to the editing controller", async () => {
    const user = userEvent.setup();
    renderWikilink("Target", "Label", { active: true });

    await user.keyboard("{Escape}");

    expect(cancelMock).toHaveBeenCalledWith("after");
    expect(commitMock).not.toHaveBeenCalled();
  });
});

describe("WikilinkElement dangling click", () => {
  it("opens the tab at the refreshed path on a refetch hit, without search or create", async () => {
    refetchAndLookupMock.mockResolvedValue("notes/refreshed.md");
    renderWikilink("Late Indexed Page");

    fireEvent.click(screen.getByRole("link"), { metaKey: true });

    await waitFor(() =>
      expect(openTabMock).toHaveBeenCalledWith("page", "notes/refreshed.md"),
    );
    expect(refetchAndLookupMock).toHaveBeenCalledWith("Late Indexed Page");
    expect(searchGetMock).not.toHaveBeenCalled();
    expect(createMutateAsyncMock).not.toHaveBeenCalled();
  });

  it("opens a case-insensitive exact-title search match instead of creating", async () => {
    searchGetMock.mockResolvedValue({
      data: [
        searchEntry("notes/decoy.md", "Something Else Entirely"),
        searchEntry("notes/untitled.md", null),
        searchEntry("notes/existing.md", "clepsydra design notes"),
      ],
    });
    renderWikilink("Clepsydra Design Notes");

    fireEvent.click(screen.getByRole("link"), { metaKey: true });

    await waitFor(() =>
      expect(openTabMock).toHaveBeenCalledWith("page", "notes/existing.md"),
    );
    expect(searchGetMock).toHaveBeenCalledWith("/api/vault/index/search", {
      params: { query: { q: "Clepsydra Design Notes" } },
    });
    expect(createMutateAsyncMock).not.toHaveBeenCalled();
  });

  it("matches search titles after NFC normalization", async () => {
    // Target uses precomposed é; the index returns decomposed e + ́.
    searchGetMock.mockResolvedValue({
      data: [searchEntry("notes/cafe.md", "Cafe\u{301} Notes")],
    });
    renderWikilink("Caf\u{e9} Notes");

    fireEvent.click(screen.getByRole("link"), { metaKey: true });

    await waitFor(() =>
      expect(openTabMock).toHaveBeenCalledWith("page", "notes/cafe.md"),
    );
    expect(createMutateAsyncMock).not.toHaveBeenCalled();
  });

  it("creates the page at the intake-derived path on a full miss, then opens it", async () => {
    searchGetMock.mockResolvedValue({
      data: [
        searchEntry("notes/near-miss.md", "Clepsydra Design Notes Extended"),
      ],
    });
    renderWikilink("Clepsydra Design Notes");

    fireEvent.click(screen.getByRole("link"), { metaKey: true });

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
    let resolveRefetch: (value: string | null) => void = () => {};
    refetchAndLookupMock.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolveRefetch = resolve;
        }),
    );
    renderWikilink("Unwritten Page");
    const link = screen.getByRole("link");

    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { metaKey: true });
    expect(refetchAndLookupMock).toHaveBeenCalledTimes(1);

    resolveRefetch("notes/finally.md");
    await waitFor(() => expect(openTabMock).toHaveBeenCalledTimes(1));
    expect(openTabMock).toHaveBeenCalledWith("page", "notes/finally.md");

    // Once the flow settles, a new click starts a fresh flow.
    fireEvent.click(link, { metaKey: true });
    expect(refetchAndLookupMock).toHaveBeenCalledTimes(2);
    resolveRefetch("notes/finally.md");
    await waitFor(() => expect(openTabMock).toHaveBeenCalledTimes(2));
  });
});
