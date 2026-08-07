import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { usePageEditorMock } = vi.hoisted(() => ({
  usePageEditorMock: vi.fn(),
}));
vi.mock("#/editor/usePageEditor", () => ({
  usePageEditor: usePageEditorMock,
}));
vi.mock("#/editor/SaveIndicator", () => ({ SaveIndicator: () => null }));
vi.mock("#/editor/PageEditorHeader", () => ({ PageEditorHeader: () => null }));
vi.mock("#/editor/SlateEditor", () => ({ SlateEditor: () => null }));
vi.mock("#/api/index", () => ({
  useBacklinks: () => ({ data: [] }),
  useOutlinks: () => ({ data: [] }),
  useSimilar: () => ({ data: [] }),
}));
vi.mock("#/api/pages", () => ({
  useAssignPage: () => ({ mutate: vi.fn() }),
}));
vi.mock("#/api/journal", () => ({
  useJournalEditorOptions: () => undefined,
  useJournalRecent: () => ({ data: [] }),
  useEnsureJournalToday: () => ({ mutateAsync: vi.fn() }),
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

import { Folio } from "../Folio";

function draftEditor() {
  return {
    isLoading: false,
    error: { status: 404 },
    isDraft: true,
    initialValue: [{ type: "paragraph", children: [{ text: "" }] }],
    editorRevision: 0,
    title: "",
    setTitle: vi.fn(),
    tags: [],
    setTags: vi.fn(),
    aliases: [],
    setAliases: vi.fn(),
    saveStatus: "saved" as const,
    saveError: null,
    onSlateChange: vi.fn(),
    saveNow: vi.fn(),
    revisionConflict: null,
    reloadAfterConflict: vi.fn(),
    createdAt: null,
    updatedAt: null,
    bodyMarkdown: "",
    kind: null,
    inferred: true,
    project: null,
  };
}

describe("Folio journal draft", () => {
  it("renders the editor surface, not FolioNotFound, for a draft", () => {
    usePageEditorMock.mockReturnValue(draftEditor());
    render(<Folio tabId="t1" path="journals/2026-08-07.md" />);
    expect(screen.queryByText(/not found/i)).toBeNull();
    expect(screen.getByText(/END OF FILE/)).toBeInTheDocument();
  });

  it("still renders FolioNotFound for a plain missing page", () => {
    usePageEditorMock.mockReturnValue({
      ...draftEditor(),
      isDraft: false,
    });
    render(<Folio tabId="t1" path="notes/missing.md" />);
    expect(screen.queryByText(/END OF FILE/)).toBeNull();
  });
});
