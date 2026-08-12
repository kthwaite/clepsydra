import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mobileLayoutState, slateProps, usePageEditorMock } = vi.hoisted(() => ({
  mobileLayoutState: { matches: false },
  slateProps: { current: null as Record<string, unknown> | null },
  usePageEditorMock: vi.fn(),
}));

vi.mock("#/editor/usePageEditor", () => ({ usePageEditor: usePageEditorMock }));
vi.mock("#/hooks/useMobileLayout", () => ({
  useMobileLayout: () => mobileLayoutState.matches,
}));
vi.mock("#/editor/SaveIndicator", () => ({ SaveIndicator: () => null }));
vi.mock("#/editor/SlateEditor", () => ({
  SlateEditor: (props: Record<string, unknown>) => {
    slateProps.current = props;
    return null;
  },
}));
vi.mock("#/api/index", () => ({
  useBacklinks: () => ({ data: [] }),
  useOutlinks: () => ({ data: [] }),
  useSimilar: () => ({ data: [] }),
  useTags: () => ({ data: [] }),
  useTagSuggestions: () => ({ data: [] }),
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
vi.mock("#/api/journal", () => ({
  useJournalEditorOptions: () => undefined,
  useJournalToday: () => ({ data: null, isLoading: false }),
  useJournalRecent: () => ({ data: [] }),
}));
vi.mock("#/lib/useProjects", () => ({ useProjects: () => [] }));
vi.mock("#/components/codex/useCollapsibleRail", () => ({
  useCollapsibleRail: () => ({
    collapsed: true,
    width: 0,
    toggle: vi.fn(),
    onResizeStart: vi.fn(),
  }),
}));
vi.mock("#/components/codex/useScrollSpy", () => ({
  useScrollSpy: () => ({ activeIndex: -1, scrollTo: vi.fn() }),
}));
vi.mock("#/components/codex/ReadingProgressContext", () => ({
  useReadingProgress: () => ({ setProgress: vi.fn() }),
  useSetReadingProgress: () => vi.fn(),
}));

import { Folio } from "../Folio";

function editor(overrides: Record<string, unknown> = {}) {
  return {
    isLoading: false,
    error: null,
    isDraft: false,
    initialValue: [{ type: "paragraph", children: [{ text: "Body" }] }],
    editorRevision: 1,
    title: "Archived article",
    setTitle: vi.fn(),
    tags: [],
    computedTags: ["archive"],
    setTags: vi.fn(),
    aliases: [],
    setAliases: vi.fn(),
    saveStatus: "saved" as const,
    saveError: null,
    onSlateChange: vi.fn(),
    saveNow: vi.fn().mockResolvedValue(undefined),
    revisionConflict: null,
    reloadAfterConflict: vi.fn(),
    createdAt: null,
    updatedAt: null,
    bodyMarkdown: "Body",
    kind: "ARCHIVE",
    inferred: false,
    project: null,
    encrypted: false,
    readonly: true,
    setReadonly: vi.fn().mockResolvedValue(undefined),
    getRevision: vi.fn(() => "rev-a"),
    ...overrides,
  };
}

const ARCHIVE_PATH = "archive/example.com/an-article.md";

describe("Folio read-only bodies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mobileLayoutState.matches = false;
    slateProps.current = null;
  });

  it("renders a protected archive body as non-editable", () => {
    usePageEditorMock.mockReturnValue(editor());

    render(<Folio tabId="t1" path={ARCHIVE_PATH} />);

    expect(slateProps.current?.readOnly).toBe(true);
  });

  it("explains why the body is protected", () => {
    usePageEditorMock.mockReturnValue(editor());

    render(<Folio tabId="t1" path={ARCHIVE_PATH} />);

    expect(screen.getByRole("status")).toHaveTextContent(/captured archive/i);
  });

  it("leaves an ordinary page editable with no notice", () => {
    usePageEditorMock.mockReturnValue(
      editor({ kind: "NOTE", computedTags: ["note"], readonly: false }),
    );

    render(<Folio tabId="t1" path="notes/a-note.md" />);

    expect(slateProps.current?.readOnly).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("clears protection when the reader chooses to edit anyway", async () => {
    const user = userEvent.setup();
    const state = editor();
    usePageEditorMock.mockReturnValue(state);

    render(<Folio tabId="t1" path={ARCHIVE_PATH} />);
    await user.click(screen.getByRole("button", { name: /edit anyway/i }));

    expect(state.setReadonly).toHaveBeenCalledWith(false);
  });
});
