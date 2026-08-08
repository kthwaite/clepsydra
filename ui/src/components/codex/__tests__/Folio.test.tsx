import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The recovery panel is the PRIMARY (declarative) invalid-tab path: usePage
// opts out of throwOnError, so a 404 surfaces as editor.error and Folio's
// early-return branch renders FolioNotFound. Mock the editor + data hooks so
// the test isolates that branch (FolioBoundary covers the thrown-error path).
const {
  mobileLayoutState,
  useCollapsibleRailMock,
  usePageEditorMock,
  useScrollSpyMock,
} = vi.hoisted(() => ({
  mobileLayoutState: { matches: false },
  useCollapsibleRailMock: vi.fn(() => ({
    collapsed: false,
    width: 240,
    toggle: vi.fn(),
    onResizeStart: vi.fn(),
  })),
  usePageEditorMock: vi.fn(),
  useScrollSpyMock: vi.fn(() => ({
    activeIndex: -1,
    scrollTo: vi.fn(),
  })),
}));
vi.mock("#/editor/usePageEditor", () => ({
  usePageEditor: usePageEditorMock,
}));
vi.mock("#/hooks/useMobileLayout", () => ({
  useMobileLayout: () => mobileLayoutState.matches,
}));
vi.mock("#/components/codex/useCollapsibleRail", () => ({
  useCollapsibleRail: useCollapsibleRailMock,
}));
vi.mock("#/components/codex/useScrollSpy", () => ({
  useScrollSpy: useScrollSpyMock,
}));
vi.mock("#/api/index", () => ({
  useBacklinks: () => ({ data: undefined }),
  useOutlinks: () => ({ data: undefined }),
  useSimilar: () => ({ data: undefined }),
}));
vi.mock("#/api/pages", () => ({
  useAssignPage: () => ({ mutate: vi.fn() }),
}));
vi.mock("#/api/encryption", () => ({
  useEncryptionConfig: () => ({
    data: { initialized: true, wrapped_identity: "wrapped" },
    isPending: false,
    error: null,
  }),
}));
vi.mock("#/crypto/EncryptionProvider", () => ({
  useOptionalEncryptionActions: () => ({ lock: vi.fn() }),
  useEncryptionActions: () => ({
    unlockWithPassword: vi.fn(),
    unlockWithImportedIdentity: vi.fn(),
  }),
}));
vi.mock("#/editor/SlateEditor", () => ({
  SlateEditor: ({
    initialValue,
    onChange,
  }: {
    initialValue: Array<{ children?: Array<{ text?: string }> }>;
    onChange: (value: Array<{ type: string; children: Array<{ text: string }> }>) => void;
  }) => (
    <textarea
      aria-label="Page body"
      data-testid="slate-editor"
      defaultValue={initialValue[0]?.children?.[0]?.text ?? ""}
      onChange={(event) =>
        onChange([
          {
            type: "paragraph",
            children: [{ text: event.currentTarget.value }],
          },
        ])
      }
    />
  ),
}));
vi.mock("#/api/journal", () => ({
  useJournalToday: () => ({ data: null, isLoading: false }),
  useJournalEditorOptions: () => undefined,
  useJournalRecent: () => ({ data: [] }),
}));
vi.mock("#/lib/useProjects", () => ({
  useProjects: () => [],
}));

import { useWorkspaceStore } from "#/store/workspace";
import { Folio } from "../Folio";

function errorEditor() {
  return {
    isLoading: false,
    error: new Error("404"),
    title: undefined,
    saveNow: vi.fn(),
    kind: undefined,
    bodyMarkdown: "",
    inferred: undefined,
    project: undefined,
    initialValue: [],
    editorRevision: 0,
  };
}
function editableEditor() {
  const initialValue = [
    { type: "paragraph", children: [{ text: "Editable body" }] },
  ];
  let editorValue = initialValue;
  const onSlateChange = vi.fn(
    (value: Array<{ type: string; children: Array<{ text: string }> }>) => {
      editorValue = value;
    },
  );
  return {
    isLoading: false,
    error: null,
    isDraft: false,
    title: "Alpha",
    setTitle: vi.fn(),
    tags: ["mobile"],
    setTags: vi.fn(),
    aliases: [],
    setAliases: vi.fn(),
    saveNow: vi.fn().mockResolvedValue(undefined),
    saveStatus: "saved" as const,
    saveError: null,
    revisionConflict: null,
    reloadAfterConflict: vi.fn(),
    kind: "NOTE",
    bodyMarkdown: "Editable body",
    inferred: false,
    project: null,
    initialValue,
    get editorValue() {
      return editorValue;
    },
    onSlateChange,
    editorRevision: 1,
    createdAt: "2026-08-08T00:00:00Z",
    updatedAt: "2026-08-08T00:00:00Z",
    encrypted: false,
    pageId: "page-alpha",
    getPlaintext: vi.fn(),
    getRevision: vi.fn(),
  };
}

describe("Folio invalid-tab recovery", () => {
  beforeEach(() => {
    mobileLayoutState.matches = false;
    useCollapsibleRailMock.mockClear();
    usePageEditorMock.mockReturnValue(errorEditor());
    useWorkspaceStore.setState({
      tabs: [{ id: "t1", type: "page", path: "notes/gone.md", label: "gone" }],
      activeTabId: "t1",
    });
  });

  it("renders the recovery panel when the page query errors", () => {
    render(<Folio tabId="t1" path="notes/gone.md" />);
    expect(screen.getByText("Folio not found.")).toBeInTheDocument();
    expect(screen.getByText("notes/gone.md")).toBeInTheDocument();
  });

  it("closes the offending tab from the recovery panel", async () => {
    const user = userEvent.setup();
    render(<Folio tabId="t1" path="notes/gone.md" />);
    await user.click(screen.getByRole("button", { name: /close tab/i }));
    expect(useWorkspaceStore.getState().tabs).toHaveLength(0);
  });

  it("renders a locked folio without mounting Slate or exposing armor", () => {
    const armor = "-----BEGIN AGE ENCRYPTED FILE----- SECRET ARMOR";
    usePageEditorMock.mockReturnValue({
      isLoading: false,
      error: null,
      isDraft: false,
      title: "Private plans",
      tags: ["private"],
      saveNow: vi.fn(),
      kind: "NOTE",
      bodyMarkdown: "",
      inferred: true,
      project: null,
      initialValue: [{ type: "paragraph", children: [{ text: armor }] }],
      editorRevision: 1,
      encrypted: true,
      encryptionState: { status: "locked" },
    });

    render(<Folio tabId="t1" path="notes/private.md" />);

    expect(
      screen.getByRole("heading", { name: "Private plans" }),
    ).toBeVisible();
    expect(screen.queryByTestId("slate-editor")).toBeNull();
    expect(document.body.textContent).not.toContain(armor);
    expect(screen.queryByText(/END OF FILE/)).toBeNull();
  });
});

describe("Folio mobile presentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mobileLayoutState.matches = true;
    usePageEditorMock.mockReturnValue(editableEditor());
    useWorkspaceStore.setState({
      tabs: [
        { id: "t1", type: "page", path: "notes/alpha.md", label: "Alpha" },
      ],
      activeTabId: "t1",
    });
  });

  it("keeps the page editable without initializing desktop rails", async () => {
    const user = userEvent.setup();
    render(<Folio tabId="t1" path="notes/alpha.md" />);

    expect(screen.getByRole("textbox", { name: "Page title" })).toHaveValue(
      "Alpha",
    );
    expect(
      screen.queryByRole("button", { name: "collapse panel" }),
    ).not.toBeInTheDocument();
    expect(useCollapsibleRailMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Document details" }));
    expect(
      screen.getByRole("dialog", { name: "Document details" }),
    ).toBeVisible();
    expect(screen.getByText("notes/alpha.md")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Page relationships" }));
    expect(
      screen.getByRole("dialog", { name: "Page relationships" }),
    ).toBeVisible();
    expect(screen.getByText("Backlinks")).toBeVisible();
  });

  it("rehydrates unsaved body state across breakpoint changes", async () => {
    const user = userEvent.setup();
    const editor = editableEditor();
    usePageEditorMock.mockReturnValue(editor);
    mobileLayoutState.matches = false;
    const { rerender } = render(
      <Folio tabId="t1" path="notes/alpha.md" />,
    );

    const desktopBody = screen.getByRole("textbox", { name: "Page body" });
    await user.clear(desktopBody);
    await user.type(desktopBody, "Unsaved across layouts");
    expect(editor.onSlateChange).toHaveBeenCalled();
    expect(editor.saveNow).not.toHaveBeenCalled();

    mobileLayoutState.matches = true;
    rerender(<Folio tabId="t1" path="notes/alpha.md" />);
    expect(screen.getByRole("textbox", { name: "Page body" })).toHaveValue(
      "Unsaved across layouts",
    );

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(editor.saveNow).toHaveBeenCalledOnce();

    mobileLayoutState.matches = false;
    rerender(<Folio tabId="t1" path="notes/alpha.md" />);
    expect(screen.getByRole("textbox", { name: "Page body" })).toHaveValue(
      "Unsaved across layouts",
    );
  });

  it("passes breakpoint changes as the scroll-spy reattach discriminator", () => {
    const editor = editableEditor();
    usePageEditorMock.mockReturnValue(editor);
    mobileLayoutState.matches = false;
    const { rerender } = render(
      <Folio tabId="t1" path="notes/alpha.md" />,
    );
    expect(useScrollSpyMock).toHaveBeenLastCalledWith(
      expect.anything(),
      1,
      false,
    );

    mobileLayoutState.matches = true;
    rerender(<Folio tabId="t1" path="notes/alpha.md" />);
    expect(useScrollSpyMock).toHaveBeenLastCalledWith(
      expect.anything(),
      1,
      true,
    );
  });
});
