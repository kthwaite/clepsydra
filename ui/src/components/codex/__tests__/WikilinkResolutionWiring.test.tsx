import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Both SlateEditor hosts must mount WikilinkResolutionProvider around the
// editor with the page's vault path, so wikilinks resolve against that page's
// outgoing links. Mock the provider to capture its `path` prop and mark its
// subtree; mock the editor + data hooks as in EditorConflictWiring.test.tsx.
const { usePageEditorMock, providerPaths } = vi.hoisted(() => ({
  usePageEditorMock: vi.fn(),
  providerPaths: [] as string[],
}));

vi.mock("#/editor/wikilinkResolution", () => ({
  WikilinkResolutionProvider: ({
    path,
    children,
  }: {
    path: string;
    children: ReactNode;
  }) => {
    providerPaths.push(path);
    return <div data-testid="wikilink-provider">{children}</div>;
  },
}));
vi.mock("#/editor/usePageEditor", () => ({
  usePageEditor: usePageEditorMock,
}));
vi.mock("#/editor/SaveIndicator", () => ({
  SaveIndicator: () => null,
}));
vi.mock("#/editor/PageEditorHeader", () => ({
  PageEditorHeader: () => null,
}));
vi.mock("#/editor/SlateEditor", () => ({
  SlateEditor: () => <div data-testid="slate-editor" />,
}));
vi.mock("#/api/index", () => ({
  useBacklinks: () => ({ data: [] }),
  useOutlinks: () => ({ data: [] }),
  useSimilar: () => ({ data: [] }),
}));
vi.mock("#/api/pages", () => ({
  useAssignPage: () => ({ mutate: vi.fn() }),
}));
vi.mock("#/api/journal", () => ({
  useJournalByDate: () => ({ data: undefined, isLoading: false, error: null }),
  useJournalRecent: () => ({ data: [] }),
  useQuickCapture: () => ({ mutate: vi.fn(), isPending: false }),
  useEnsureJournalToday: () => ({ mutateAsync: vi.fn() }),
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

import { Diurnal } from "../Diurnal";
import { Folio } from "../Folio";

function loadedEditor() {
  return {
    isLoading: false,
    error: null,
    isDraft: false,
    initialValue: [{ type: "paragraph", children: [{ text: "Body" }] }],
    editorRevision: 0,
    title: "Body",
    setTitle: vi.fn(),
    tags: [],
    setTags: vi.fn(),
    aliases: [],
    setAliases: vi.fn(),
    saveStatus: "saved",
    saveError: null,
    revisionConflict: null,
    reloadAfterConflict: vi.fn(),
    onSlateChange: vi.fn(),
    saveNow: vi.fn(),
    createdAt: null,
    updatedAt: null,
    bodyMarkdown: "Body\n",
    kind: "NOTE",
    inferred: true,
    project: null,
  };
}

describe("wikilink resolution provider wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerPaths.length = 0;
  });

  it("Folio wraps its SlateEditor in a provider bound to the folio path", () => {
    usePageEditorMock.mockReturnValue(loadedEditor());

    render(<Folio tabId="tab-1" path="notes/draft.md" />);

    expect(providerPaths).toEqual(["notes/draft.md"]);
    const provider = screen.getByTestId("wikilink-provider");
    expect(within(provider).getByTestId("slate-editor")).toBeInTheDocument();
  });

  it("Diurnal wraps its SlateEditor in a provider bound to the journal path", () => {
    usePageEditorMock.mockReturnValue(loadedEditor());

    render(<Diurnal />);

    // Same deterministic journal path the editor itself is bound to.
    const [editorPath] = usePageEditorMock.mock.calls[0];
    expect(editorPath).toMatch(/^journals\/\d{4}-\d{2}-\d{2}\.md$/);
    expect(providerPaths).toEqual([editorPath]);
    const provider = screen.getByTestId("wikilink-provider");
    expect(within(provider).getByTestId("slate-editor")).toBeInTheDocument();
  });
});
