import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

type RecoveryIndicatorProps = {
  revisionConflict?: { currentRevision: string } | null;
  onReloadAfterConflict?: () => Promise<void>;
};

const { usePageEditorMock } = vi.hoisted(() => ({
  usePageEditorMock: vi.fn(),
}));

vi.mock("#/editor/usePageEditor", () => ({
  usePageEditor: usePageEditorMock,
}));
vi.mock("#/editor/SaveIndicator", () => ({
  SaveIndicator: ({
    revisionConflict,
    onReloadAfterConflict,
  }: RecoveryIndicatorProps) => (
    <button
      type="button"
      data-revision={revisionConflict?.currentRevision}
      onClick={() => void onReloadAfterConflict?.()}
    >
      Reload conflict
    </button>
  ),
}));
vi.mock("#/editor/PageEditorHeader", () => ({
  PageEditorHeader: () => null,
}));
vi.mock("#/editor/SlateEditor", () => ({
  SlateEditor: () => null,
}));
vi.mock("#/api/index", () => ({
  useBacklinks: () => ({ data: [] }),
  useOutlinks: () => ({ data: [] }),
  useSimilar: () => ({ data: [] }),
  useTags: () => ({ data: [] }),
  useTagSuggestions: () => ({
    data: [],
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock("#/api/pages", () => ({
  useAssignPage: () => ({ mutate: vi.fn() }),
}));
vi.mock("#/api/journal", () => ({
  useJournalToday: () => ({ data: null, isLoading: false }),
  useJournalRecent: () => ({ data: [] }),
  useEnsureJournalToday: () => ({ mutateAsync: vi.fn() }),
  useJournalEditorOptions: () => undefined,
}));
vi.mock("#/lib/useProjects", () => ({
  useProjects: () => [],
}));
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

import { Folio } from "../Folio";

function loadedEditor(reloadAfterConflict: () => Promise<void>) {
  return {
    isLoading: false,
    error: null,
    isDraft: false,
    initialValue: [{ type: "paragraph", children: [{ text: "Draft" }] }],
    editorRevision: 1,
    title: "Draft",
    setTitle: vi.fn(),
    tags: [],
    setTags: vi.fn(),
    aliases: [],
    setAliases: vi.fn(),
    saveStatus: "error",
    saveError: "page changed since it was loaded",
    revisionConflict: { currentRevision: "rev-b" },
    reloadAfterConflict,
    onSlateChange: vi.fn(),
    saveNow: vi.fn(),
    createdAt: null,
    updatedAt: null,
    bodyMarkdown: "Draft\n",
    kind: "NOTE",
    inferred: true,
    project: null,
  };
}

describe("desktop conflict recovery wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wires Folio conflict reload to its page editor", async () => {
    const user = userEvent.setup();
    const reloadAfterConflict = vi.fn().mockResolvedValue(undefined);
    usePageEditorMock.mockReturnValue(loadedEditor(reloadAfterConflict));

    render(<Folio tabId="tab-1" path="notes/draft.md" />);
    const reload = screen.getByRole("button", { name: "Reload conflict" });
    expect(reload).toHaveAttribute("data-revision", "rev-b");
    await user.click(reload);

    expect(reloadAfterConflict).toHaveBeenCalledTimes(1);
  });
});
