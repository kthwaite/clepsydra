import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { createEditor, type Descendant } from "slate";
import {
  Editable,
  type RenderElementProps,
  Slate,
  withReact,
} from "slate-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withSchema } from "#/editor/schema/withSchema";
import type { WikilinkElement as WikilinkElementType } from "#/editor/types";
import type * as WikilinkEditingExports from "#/editor/wikilinkEditing";
import { usePreviewStore } from "#/store/preview";

type CapturedCLinkProps = {
  path?: string;
  onClick?: (e: unknown) => void;
  className?: string;
  children?: ReactNode;
};

const {
  lookupMock,
  openTabMock,
  resolveOrCreateMock,
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
    openTabMock: vi.fn(),
    resolveOrCreateMock: vi.fn(),
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
  useWikilinkResolution: () => ({ lookup: lookupMock }),
}));
vi.mock("#/editor/useResolveOrCreateWikilinkTarget", () => ({
  useResolveOrCreateWikilinkTarget: () => ({
    resolveOrCreate: resolveOrCreateMock,
  }),
}));
vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
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
      <a
        {...{
          role: "link" as const,
          onClick: props.onClick,
          onKeyDown: (event: { key: string }) => {
            if (event.key === "Enter") props.onClick?.(event);
          },
        }}
        tabIndex={0}
        className={props.className}
      >
        {props.children}
      </a>
    );
  },
}));

import { WikilinkElement } from "#/editor/elements/WikilinkElement";

function renderWikilink(
  target: string,
  alias?: string,
  {
    active = false,
    readOnly = false,
  }: { active?: boolean; readOnly?: boolean } = {},
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
      <Editable renderElement={renderElement} readOnly={readOnly} />
    </Slate>,
  );
  return { ...result, editor, element };
}

function lastCLink() {
  const props = clinkCalls[clinkCalls.length - 1];
  expect(props).toBeDefined();
  return props;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  clinkCalls.length = 0;
  editingController.active = null;
  usePreviewStore.setState({ windows: [], hoverId: null, topZ: 200 });
  lookupMock.mockReturnValue(null);
  resolveOrCreateMock.mockResolvedValue({
    path: "notes/new-topic.md",
    title: "New Topic",
  });
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
  it("renders a dedicated muted dashed trigger instead of CLink", () => {
    renderWikilink("Unwritten Page");

    expect(clinkCalls).toHaveLength(0);
    const link = screen.getByRole("link");
    expect(link).not.toHaveAttribute("href");
    expect(link.className).toContain("text-ink-mute");
    expect(link.className).toContain("decoration-dashed");
    expect(link.className).toContain("cursor-pointer");
    expect(link.className).toContain("relative");
  });

  it("shows only the alias for a dangling labeled link", () => {
    renderWikilink("Unwritten Page", "someday");

    expect(screen.getByText("someday")).toBeInTheDocument();
    expect(screen.queryByText("Unwritten Page")).toBeNull();
  });

  it("starts inline editing from a plain click on the dedicated trigger", () => {
    renderWikilink("Unwritten Page");

    fireEvent.click(screen.getByRole("link"));

    expect(beginMock).toHaveBeenCalledWith([0, 1], "end", "after");
    expect(resolveOrCreateMock).not.toHaveBeenCalled();
    expect(openTabMock).not.toHaveBeenCalled();
  });

  it("routes Enter through editable activation and contains the keyboard event", () => {
    const bubbledKeyDown = vi.fn();
    document.addEventListener("keydown", bubbledKeyDown);
    renderWikilink("Unwritten Page");

    try {
      const defaultAllowed = fireEvent.keyDown(screen.getByRole("link"), {
        key: "Enter",
      });

      expect(defaultAllowed).toBe(false);
      expect(bubbledKeyDown).not.toHaveBeenCalled();
      expect(beginMock).toHaveBeenCalledWith([0, 1], "end", "after");
      expect(resolveOrCreateMock).not.toHaveBeenCalled();
      expect(openTabMock).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", bubbledKeyDown);
    }
  });

  it.each([
    ["Cmd", { metaKey: true }],
    ["Ctrl", { ctrlKey: true }],
  ])(
    "creates and opens an unresolved target on %s+Enter",
    async (_modifier, eventInit) => {
      renderWikilink("New Topic");

      const defaultAllowed = fireEvent.keyDown(screen.getByRole("link"), {
        key: "Enter",
        ...eventInit,
      });

      expect(defaultAllowed).toBe(false);
      await waitFor(() =>
        expect(openTabMock).toHaveBeenCalledWith("page", "notes/new-topic.md"),
      );
      expect(resolveOrCreateMock).toHaveBeenCalledOnce();
      expect(resolveOrCreateMock).toHaveBeenCalledWith("New Topic");
      expect(beginMock).not.toHaveBeenCalled();
    },
  );

  it("contains read-only Enter without editing, creation, navigation, or Slate mutation", () => {
    const { editor } = renderWikilink("Unwritten Page", undefined, {
      readOnly: true,
    });
    const originalDescendants = structuredClone(editor.children);
    const link = screen.getByRole("link");

    expect(fireEvent.keyDown(link, { key: "Enter" })).toBe(false);
    expect(fireEvent.keyDown(link, { key: "Enter", metaKey: true })).toBe(
      false,
    );

    expect(beginMock).not.toHaveBeenCalled();
    expect(resolveOrCreateMock).not.toHaveBeenCalled();
    expect(openTabMock).not.toHaveBeenCalled();
    expect(editor.children).toEqual(originalDescendants);
  });
});

describe("WikilinkElement editing and navigation", () => {
  it("closes the transient preview and begins inline editing on plain click", () => {
    lookupMock.mockReturnValue("notes/target.md");
    usePreviewStore.setState({
      windows: [
        {
          id: "hover-target",
          path: "notes/target.md",
          x: 8,
          y: 20,
          pinned: false,
          minimized: false,
          z: 201,
        },
      ],
      hoverId: "hover-target",
      topZ: 201,
    });
    renderWikilink("Target");

    fireEvent.click(screen.getByRole("link"));

    expect(beginMock).toHaveBeenCalledWith([0, 1], "end", "after");
    expect(usePreviewStore.getState().hoverId).toBeNull();
    expect(openTabMock).not.toHaveBeenCalled();
    expect(resolveOrCreateMock).not.toHaveBeenCalled();
  });

  it.each([
    ["Cmd", { metaKey: true }],
    ["Ctrl", { ctrlKey: true }],
  ])(
    "closes the transient preview and opens a resolved target on %s-click",
    (_modifier, eventInit) => {
      lookupMock.mockReturnValue("notes/target.md");
      usePreviewStore.setState({
        windows: [
          {
            id: "hover-target",
            path: "notes/target.md",
            x: 8,
            y: 20,
            pinned: false,
            minimized: false,
            z: 201,
          },
        ],
        hoverId: "hover-target",
        topZ: 201,
      });
      renderWikilink("Target");

      fireEvent.click(screen.getByRole("link"), eventInit);

      expect(usePreviewStore.getState().hoverId).toBeNull();
      expect(openTabMock).toHaveBeenCalledWith("page", "notes/target.md");
      expect(beginMock).not.toHaveBeenCalled();
      expect(resolveOrCreateMock).not.toHaveBeenCalled();
    },
  );

  it("preserves pinned and minimized previews while closing only the transient preview", () => {
    lookupMock.mockReturnValue("notes/target.md");
    usePreviewStore.setState({
      windows: [
        {
          id: "pinned-other",
          path: "notes/other.md",
          x: 12,
          y: 16,
          pinned: true,
          minimized: true,
          z: 201,
        },
        {
          id: "hover-target",
          path: "notes/target.md",
          x: 8,
          y: 20,
          pinned: false,
          minimized: false,
          z: 202,
        },
      ],
      hoverId: "hover-target",
      topZ: 202,
    });
    renderWikilink("Target");

    fireEvent.click(screen.getByRole("link"), { metaKey: true });

    expect(usePreviewStore.getState().hoverId).toBeNull();
    expect(usePreviewStore.getState().windows).toEqual([
      expect.objectContaining({
        id: "pinned-other",
        pinned: true,
        minimized: true,
      }),
    ]);
    expect(openTabMock).toHaveBeenCalledWith("page", "notes/target.md");
  });

  it("opens a resolved target on plain click in read-only mode", () => {
    lookupMock.mockReturnValue("notes/target.md");
    renderWikilink("Target", undefined, { readOnly: true });

    fireEvent.click(screen.getByRole("link"));

    expect(openTabMock).toHaveBeenCalledWith("page", "notes/target.md");
    expect(beginMock).not.toHaveBeenCalled();
    expect(resolveOrCreateMock).not.toHaveBeenCalled();
  });

  it("explains but never mutates a dangling target in read-only mode", () => {
    const { editor } = renderWikilink("Unwritten Page", undefined, {
      readOnly: true,
    });
    const originalDescendants = structuredClone(editor.children);
    const link = screen.getByRole("link");

    fireEvent.focus(link);
    expect(
      screen.getByRole("dialog", { name: "Unwritten Page" }),
    ).toHaveTextContent("Page does not exist.");
    expect(
      screen.queryByRole("button", { name: "Create page" }),
    ).not.toBeInTheDocument();

    fireEvent.click(link);
    fireEvent.click(link, { metaKey: true });

    expect(beginMock).not.toHaveBeenCalled();
    expect(resolveOrCreateMock).not.toHaveBeenCalled();
    expect(openTabMock).not.toHaveBeenCalled();
    expect(editor.children).toEqual(originalDescendants);
  });

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
  it("closes the transient preview and opens the path returned by the shared resolver", async () => {
    resolveOrCreateMock.mockResolvedValue({
      path: "notes/new-topic.md",
      title: "New Topic",
    });
    usePreviewStore.setState({
      windows: [
        {
          id: "hover-other",
          path: "notes/other.md",
          x: 8,
          y: 20,
          pinned: false,
          minimized: false,
          z: 201,
        },
      ],
      hoverId: "hover-other",
      topZ: 201,
    });
    renderWikilink("New Topic");

    fireEvent.click(screen.getByRole("link"), { metaKey: true });

    expect(usePreviewStore.getState().hoverId).toBeNull();
    await waitFor(() =>
      expect(openTabMock).toHaveBeenCalledWith("page", "notes/new-topic.md"),
    );
    expect(resolveOrCreateMock).toHaveBeenCalledWith("New Topic");
  });

  it("creates from the popover, opens the returned page, and leaves Slate unchanged", async () => {
    const { editor } = renderWikilink("New Topic");
    const originalDescendants = structuredClone(editor.children);
    fireEvent.focus(screen.getByRole("link"));

    fireEvent.click(screen.getByRole("button", { name: "Create page" }));

    await waitFor(() =>
      expect(openTabMock).toHaveBeenCalledWith("page", "notes/new-topic.md"),
    );
    expect(resolveOrCreateMock).toHaveBeenCalledOnce();
    expect(resolveOrCreateMock).toHaveBeenCalledWith("New Topic");
    expect(editor.children).toEqual(originalDescendants);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
  it("coalesces popover and modifier activation while pending and retries after settlement", async () => {
    const pending = deferred<{ path: string; title: string }>();
    resolveOrCreateMock.mockReturnValue(pending.promise);
    renderWikilink("New Topic");
    const link = screen.getByRole("link");
    fireEvent.focus(link);

    fireEvent.click(screen.getByRole("button", { name: "Create page" }));
    expect(
      await screen.findByRole("button", { name: "Creating…" }),
    ).toBeDisabled();
    fireEvent.click(link, { metaKey: true });
    expect(resolveOrCreateMock).toHaveBeenCalledTimes(1);

    pending.resolve({ path: "notes/new-topic.md", title: "New Topic" });
    await waitFor(() => expect(openTabMock).toHaveBeenCalledTimes(1));
    expect(openTabMock).toHaveBeenCalledWith("page", "notes/new-topic.md");

    fireEvent.click(link, { metaKey: true });
    await waitFor(() => expect(openTabMock).toHaveBeenCalledTimes(2));
    expect(resolveOrCreateMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the Slate node unchanged across failed creation and retry", async () => {
    resolveOrCreateMock
      .mockRejectedValueOnce(new Error("create failed"))
      .mockResolvedValueOnce({
        path: "notes/new-topic.md",
        title: "New Topic",
      });
    const { editor } = renderWikilink("New Topic");
    const originalDescendants = structuredClone(editor.children);
    fireEvent.focus(screen.getByRole("link"));

    fireEvent.click(screen.getByRole("button", { name: "Create page" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Creation failed — try again",
    );
    expect(openTabMock).not.toHaveBeenCalled();
    expect(editor.children).toEqual(originalDescendants);

    fireEvent.click(screen.getByRole("button", { name: "Create page" }));

    await waitFor(() =>
      expect(openTabMock).toHaveBeenCalledWith("page", "notes/new-topic.md"),
    );
    expect(resolveOrCreateMock).toHaveBeenCalledTimes(2);
    expect(editor.children).toEqual(originalDescendants);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});
