import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./FolioProperties.mock";

const { mobileLayoutState, usePageEditorMock } = vi.hoisted(() => ({
  mobileLayoutState: { matches: false },
  usePageEditorMock: vi.fn(),
}));

vi.mock("#/editor/usePageEditor", () => ({ usePageEditor: usePageEditorMock }));
vi.mock("#/hooks/useMobileLayout", () => ({
  useMobileLayout: () => mobileLayoutState.matches,
}));
vi.mock("#/editor/SaveIndicator", () => ({ SaveIndicator: () => null }));
vi.mock("#/editor/SlateEditor", () => ({ SlateEditor: () => null }));
vi.mock("#/api/index", () => ({
  useBacklinks: () => ({ data: [] }),
  useOutlinks: () => ({ data: [] }),
  useSimilar: () => ({ data: [] }),
  useTags: () => ({ data: [] }),
  useTagSuggestions: () => ({
    data: [],
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock("#/api/pages", () => ({
  useAssignPage: () => ({ mutate: vi.fn() }),
  useArchivePage: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
    title: "Tagged page",
    setTitle: vi.fn(),
    tags: ["research"],
    computedTags: ["journal"],
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
    kind: "JOURNAL",
    inferred: false,
    project: null,
    encrypted: false,
    getRevision: vi.fn(() => "rev-a"),
    ...overrides,
  };
}

describe("Folio computed tags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mobileLayoutState.matches = false;
  });

  it("renders the API-computed kind tag once and keeps it out of edit actions", async () => {
    const user = userEvent.setup();
    const state = editor();
    usePageEditorMock.mockReturnValue(state);

    render(<Folio tabId="t1" path="journals/2026-08-11.md" />);

    const computed = screen.getByRole("grid", { name: "Read-only Tags" });
    const editable = screen.getByRole("grid", { name: "Tags" });
    expect(screen.getAllByText("journal")).toHaveLength(1);
    expect(within(computed).getByText("journal")).toBeInTheDocument();
    expect(within(computed).queryByRole("button")).toBeNull();
    expect(within(editable).getByText("research")).toBeInTheDocument();
    expect(within(editable).getAllByRole("button")).toHaveLength(1);

    const input = screen.getByRole("combobox", { name: "Add tags" });
    await user.click(input);
    await user.keyboard("{Backspace}");
    expect(state.setTags).toHaveBeenCalledWith([]);
    expect(state.setTags).not.toHaveBeenCalledWith(
      expect.arrayContaining(["journal"]),
    );
    fireEvent.blur(input);
    expect(state.saveNow).toHaveBeenCalledOnce();
  });

  it("keeps a same-spelling user tag removable when the API reports no computed tag", async () => {
    const user = userEvent.setup();
    const state = editor({
      kind: "NOTE",
      tags: ["journal"],
      computedTags: [],
    });
    usePageEditorMock.mockReturnValue(state);

    render(<Folio tabId="t1" path="notes/tagged.md" />);

    expect(screen.queryByRole("grid", { name: "Read-only Tags" })).toBeNull();
    const editable = screen.getByRole("grid", { name: "Tags" });
    expect(within(editable).getByText("journal")).toBeInTheDocument();
    await user.click(within(editable).getByRole("button"));
    expect(state.setTags).toHaveBeenCalledWith([]);
  });

  it("shows stored and computed tags exactly once on a locked Folio", () => {
    usePageEditorMock.mockReturnValue(
      editor({
        kind: "NOTE",
        tags: ["journal"],
        computedTags: ["note"],
        encrypted: true,
        encryptionState: { status: "locked" },
      }),
    );

    render(<Folio tabId="t1" path="notes/locked.md" />);

    expect(screen.getByLabelText("Tags")).toHaveTextContent("#journal");
    expect(screen.getByLabelText("Read-only Tags")).toHaveTextContent("#note");
    expect(screen.getAllByText(/#(?:journal|note)/)).toHaveLength(2);
  });

  it("shows effective tags without edit controls in a read-only Folio", () => {
    usePageEditorMock.mockReturnValue(
      editor({
        kind: "AI_CONVERSATION",
        tags: ["journal"],
        computedTags: ["ai_conversation"],
      }),
    );

    render(<Folio tabId="t1" path="conversations/readonly.md" />);

    const metadata = screen.getByRole("region", { name: "Page metadata" });
    expect(within(metadata).getByText("journal")).toBeInTheDocument();
    expect(within(metadata).getByText("ai_conversation")).toBeInTheDocument();
    expect(within(metadata).queryByRole("button")).toBeNull();
  });
});
