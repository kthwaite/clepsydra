import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useMemo } from "react";
import { createEditor, type Descendant, type Editor } from "slate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TagCount } from "#/api/types";
import type { CustomEditor } from "#/editor/types";

// The recovery panel is the PRIMARY (declarative) invalid-tab path: usePage
// opts out of throwOnError, so a 404 surfaces as editor.error and Folio's
// early-return branch renders FolioNotFound. Mock the editor + data hooks so
// the test isolates that branch (FolioBoundary covers the thrown-error path).
const {
  mobileLayoutState,
  mountedSlateEditors,
  navigateMock,
  restorationFrames,
  routerHistory,
  useCollapsibleRailMock,
  usePageEditorMock,
  useTagSuggestionsMock,
  useTagsMock,
  useScrollSpyMock,
} = vi.hoisted(() => ({
  mobileLayoutState: { matches: false },
  mountedSlateEditors: [] as Editor[],
  navigateMock: vi.fn(),
  restorationFrames: [] as FrameRequestCallback[],
  routerHistory: {
    back: vi.fn(),
    canGoBack: vi.fn(() => false),
    location: { state: { __TSR_index: 0 } as Record<string, unknown> },
  },
  useCollapsibleRailMock: vi.fn(() => ({
    collapsed: false,
    width: 240,
    toggle: vi.fn(),
    onResizeStart: vi.fn(),
  })),
  useTagSuggestionsMock: vi.fn(),
  useTagsMock: vi.fn<
    () => { data: TagCount[] | undefined; error?: Error }
  >(() => ({
    data: [
      { tag: "research", count: 4 },
      { tag: "ritual", count: 1 },
    ],
  })),
  usePageEditorMock: vi.fn(),
  useScrollSpyMock: vi.fn(() => ({
    activeIndex: -1,
    scrollTo: vi.fn(),
  })),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  useRouter: () => ({ history: routerHistory }),
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
  useTagSuggestions: useTagSuggestionsMock,
  useTags: useTagsMock,
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
    editorRef,
  }: {
    initialValue: Descendant[];
    onChange: (value: Descendant[]) => void;
    editorRef?: { current: CustomEditor | null };
  }) => {
    const editor = useMemo(() => {
      const instance = createEditor() as CustomEditor;
      instance.children = initialValue;
      mountedSlateEditors.push(instance);
      return instance;
    }, [initialValue]);

    useEffect(() => {
      if (editorRef) editorRef.current = editor;
      return () => {
        if (editorRef?.current === editor) editorRef.current = null;
      };
    }, [editor, editorRef]);

    return (
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
    );
  },
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
import {
  clearFolioRestoration,
  type FolioRestoration,
  readFolioRestoration,
  saveFolioRestoration,
} from "#/store/folioRestoration";
import { Folio } from "../Folio";

beforeEach(() => {
  clearFolioRestoration("t1");
  mountedSlateEditors.length = 0;
  restorationFrames.length = 0;
  useTagSuggestionsMock.mockImplementation((query: string) => ({
    data: query.startsWith("clep")
      ? [{ tag: "clepsydra", count: 9 }]
      : [
          { tag: "research", count: 4 },
          { tag: "ritual", count: 1 },
        ],
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  }));
  useTagsMock.mockReturnValue({
    data: [
      { tag: "research", count: 4 },
      { tag: "ritual", count: 1 },
    ],
  });
});

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

function activeSlateEditor(): Editor {
  const editor = mountedSlateEditors[mountedSlateEditors.length - 1];
  if (!editor) throw new Error("Expected SlateEditor to mount an editor");
  return editor;
}

function folioScrollContainer(): HTMLDivElement {
  let element = screen.getByTestId("slate-editor").parentElement;
  while (element) {
    if (
      element.classList.contains("cl-noscroll") &&
      (element.classList.contains("overflow-auto") ||
        element.classList.contains("overflow-y-auto"))
    ) {
      return element as HTMLDivElement;
    }
    element = element.parentElement;
  }
  throw new Error("Expected a Folio scroll container");
}

function flushRestorationFrame() {
  const callbacks = restorationFrames.splice(0);
  expect(callbacks).not.toHaveLength(0);
  act(() => {
    for (const callback of callbacks) callback(performance.now());
  });
}

function restorationRecord(
  overrides: Partial<FolioRestoration> = {},
): FolioRestoration {
  return {
    tabId: "t1",
    path: "notes/alpha.md",
    revision: "revision-1",
    scrollTop: 48,
    anchor: { path: [0, 0], offset: 2, text: "Editable body" },
    focus: { path: [0, 0], offset: 7, text: "Editable body" },
    ...overrides,
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

  it("suggests indexed tags while editing folio tags", async () => {
    const user = userEvent.setup();
    usePageEditorMock.mockReturnValue(editableEditor());

    render(<Folio tabId="t1" path="notes/alpha.md" />);
    await user.type(
      screen.getByRole("combobox", { name: "Add tags" }),
      "res",
    );

    expect(
      await screen.findByRole("option", { name: "research" }),
    ).toBeInTheDocument();
  });

  it("queries a bounded suggestion set as the Folio draft changes", async () => {
    const user = userEvent.setup();
    usePageEditorMock.mockReturnValue(editableEditor());
    useTagsMock.mockClear();

    render(<Folio tabId="t1" path="notes/alpha.md" />);
    const input = screen.getByRole("combobox", { name: "Add tags" });
    await user.type(input, "clep");

    await waitFor(() =>
      expect(useTagSuggestionsMock).toHaveBeenCalledWith("clep", 12, true),
    );
    expect(screen.getByRole("option", { name: "clepsydra" })).toBeVisible();
    expect(useTagsMock).not.toHaveBeenCalled();

    await user.type(input, "sydra");
    await waitFor(() =>
      expect(useTagSuggestionsMock).toHaveBeenCalledWith(
        "clepsydra",
        12,
        true,
      ),
    );
    expect(screen.getByRole("option", { name: "clepsydra" })).toBeVisible();
  });

  it("keeps raw tag editing and blur-save operational without a tag index", async () => {
    const user = userEvent.setup();
    const editor = editableEditor();
    usePageEditorMock.mockReturnValue(editor);
    useTagSuggestionsMock.mockReturnValue({
      data: undefined,
      error: new Error("tag suggestions unavailable"),
      isLoading: false,
      refetch: vi.fn(),
    });

    render(<Folio tabId="t1" path="notes/alpha.md" />);
    const input = screen.getByRole("combobox", { name: "Add tags" });
    await user.type(input, "ad-hoc");

    expect(
      screen.queryByRole("listbox", { name: "Tag suggestions" }),
    ).toBeNull();
    fireEvent.blur(input);

    expect(editor.setTags).toHaveBeenCalledOnce();
    expect(editor.setTags).toHaveBeenCalledWith(["mobile", "ad-hoc"]);
    expect(editor.saveNow).toHaveBeenCalledOnce();
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

describe("Folio in-session restoration", () => {
  beforeEach(() => {
    mobileLayoutState.matches = false;
    useWorkspaceStore.setState({
      tabs: [
        { id: "t1", type: "page", path: "notes/alpha.md", label: "Alpha" },
      ],
      activeTabId: "t1",
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      restorationFrames.push(callback);
      return restorationFrames.length;
    });
  });

  it("restores scroll and selection only after the remounted editor is available", () => {
    const departing = editableEditor();
    departing.getRevision.mockReturnValue("revision-1");
    usePageEditorMock.mockReturnValue(departing);
    const firstMount = render(<Folio tabId="t1" path="notes/alpha.md" />);
    const savedSelection = {
      anchor: { path: [0, 0], offset: 2 },
      focus: { path: [0, 0], offset: 7 },
    };
    activeSlateEditor().selection = savedSelection;
    folioScrollContainer().scrollTop = 96;
    screen.getByRole("textbox", { name: "Page body" }).focus();

    firstMount.unmount();

    const returning = editableEditor();
    returning.initialValue[0].children[0].text =
      "Edited leaf, unchanged revision";
    returning.getRevision.mockReturnValue("revision-1");
    usePageEditorMock.mockReturnValue(returning);
    render(<Folio tabId="t1" path="notes/alpha.md" />);
    const restoredEditor = activeSlateEditor();
    const restoredScroller = folioScrollContainer();
    expect(restoredEditor.selection).toBeNull();
    expect(restoredScroller.scrollTop).toBe(0);

    flushRestorationFrame();

    expect(restoredScroller.scrollTop).toBe(96);
    expect(restoredEditor.selection).toEqual(savedSelection);
  });

  it("keeps a changed-revision selection unset when its saved leaf text is stale", () => {
    const departing = editableEditor();
    departing.getRevision.mockReturnValue("revision-1");
    usePageEditorMock.mockReturnValue(departing);
    const firstMount = render(<Folio tabId="t1" path="notes/alpha.md" />);
    activeSlateEditor().selection = {
      anchor: { path: [0, 0], offset: 2 },
      focus: { path: [0, 0], offset: 7 },
    };
    folioScrollContainer().scrollTop = 64;
    firstMount.unmount();

    const returning = editableEditor();
    returning.initialValue[0].children[0].text = "Different leaf text";
    returning.getRevision.mockReturnValue("revision-2");
    usePageEditorMock.mockReturnValue(returning);
    render(<Folio tabId="t1" path="notes/alpha.md" />);
    const restoredEditor = activeSlateEditor();
    const restoredScroller = folioScrollContainer();

    flushRestorationFrame();

    expect(restoredScroller.scrollTop).toBe(64);
    expect(restoredEditor.selection).toBeNull();
  });

  it("clears restoration when the same tab is repointed to another path", () => {
    saveFolioRestoration(restorationRecord());
    const departing = editableEditor();
    departing.getRevision.mockReturnValue("revision-1");
    usePageEditorMock.mockReturnValue(departing);
    const mounted = render(<Folio tabId="t1" path="notes/alpha.md" />);
    activeSlateEditor().selection = {
      anchor: { path: [0, 0], offset: 2 },
      focus: { path: [0, 0], offset: 7 },
    };
    folioScrollContainer().scrollTop = 88;
    useWorkspaceStore
      .getState()
      .updateTabPath("t1", "notes/beta.md", "Beta");
    mounted.unmount();

    expect(readFolioRestoration("t1", "notes/alpha.md")).toBeNull();
  });

  it("restores the mobile document scroll container", () => {
    mobileLayoutState.matches = true;
    saveFolioRestoration(
      restorationRecord({ scrollTop: 72, anchor: null, focus: null }),
    );
    const returning = editableEditor();
    returning.getRevision.mockReturnValue("revision-1");
    usePageEditorMock.mockReturnValue(returning);

    render(<Folio tabId="t1" path="notes/alpha.md" />);
    const restoredScroller = folioScrollContainer();
    flushRestorationFrame();

    expect(restoredScroller).toHaveClass("overflow-y-auto");
    expect(restoredScroller.scrollTop).toBe(72);
  });

  it("clears restoration when the page is unavailable", () => {
    saveFolioRestoration(restorationRecord());
    usePageEditorMock.mockReturnValue(errorEditor());

    render(<Folio tabId="t1" path="notes/alpha.md" />);

    expect(readFolioRestoration("t1", "notes/alpha.md")).toBeNull();
  });

  it("clears restoration when its tab is deleted", () => {
    saveFolioRestoration(restorationRecord());

    useWorkspaceStore.getState().closeTab("t1");

    expect(readFolioRestoration("t1", "notes/alpha.md")).toBeNull();
  });

  it("restores selection without taking focus from an explicit control", () => {
    saveFolioRestoration(restorationRecord());
    const returning = editableEditor();
    returning.getRevision.mockReturnValue("revision-1");
    usePageEditorMock.mockReturnValue(returning);
    render(
      <>
        <button type="button">Dialog action</button>
        <Folio tabId="t1" path="notes/alpha.md" />
      </>,
    );
    const dialogAction = screen.getByRole("button", {
      name: "Dialog action",
    });
    dialogAction.focus();

    flushRestorationFrame();

    expect(activeSlateEditor().selection).toEqual({
      anchor: { path: [0, 0], offset: 2 },
      focus: { path: [0, 0], offset: 7 },
    });
    expect(dialogAction).toHaveFocus();
  });
});
