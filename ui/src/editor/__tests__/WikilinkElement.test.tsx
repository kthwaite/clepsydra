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
    expect(resolveOrCreateMock).not.toHaveBeenCalled();
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
      expect(resolveOrCreateMock).not.toHaveBeenCalled();
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
  it("opens the path returned by the shared resolver", async () => {
    resolveOrCreateMock.mockResolvedValue({
      path: "notes/new-topic.md",
      title: "New Topic",
    });
    renderWikilink("New Topic");

    fireEvent.click(screen.getByRole("link"), { metaKey: true });

    await waitFor(() =>
      expect(openTabMock).toHaveBeenCalledWith("page", "notes/new-topic.md"),
    );
    expect(resolveOrCreateMock).toHaveBeenCalledWith("New Topic");
  });

  it("coalesces pending modifier-clicks and allows activation after settlement", async () => {
    const pending = deferred<{ path: string; title: string }>();
    resolveOrCreateMock.mockReturnValue(pending.promise);
    renderWikilink("New Topic");
    const link = screen.getByRole("link");

    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { metaKey: true });
    expect(resolveOrCreateMock).toHaveBeenCalledTimes(1);

    pending.resolve({ path: "notes/new-topic.md", title: "New Topic" });
    await waitFor(() => expect(openTabMock).toHaveBeenCalledTimes(1));
    expect(openTabMock).toHaveBeenCalledWith("page", "notes/new-topic.md");

    fireEvent.click(link, { metaKey: true });
    await waitFor(() => expect(openTabMock).toHaveBeenCalledTimes(2));
    expect(resolveOrCreateMock).toHaveBeenCalledTimes(2);
  });

  it("leaves the link dangling when resolution or creation fails", async () => {
    resolveOrCreateMock.mockRejectedValue(new Error("create failed"));
    renderWikilink("New Topic");

    fireEvent.click(screen.getByRole("link"), { metaKey: true });

    await waitFor(() =>
      expect(resolveOrCreateMock).toHaveBeenCalledWith("New Topic"),
    );
    expect(openTabMock).not.toHaveBeenCalled();
  });
});
