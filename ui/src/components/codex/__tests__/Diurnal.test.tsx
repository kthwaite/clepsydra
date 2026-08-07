import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { usePageEditorMock, ensureMutateAsyncMock } = vi.hoisted(() => ({
  usePageEditorMock: vi.fn(),
  ensureMutateAsyncMock: vi.fn(),
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
}));
vi.mock("#/api/journal", () => ({
  useJournalByDate: () => ({ data: undefined, isLoading: false, error: null }),
  useJournalRecent: () => ({ data: [] }),
  useQuickCapture: () => ({ mutate: vi.fn(), isPending: false }),
  useEnsureJournalToday: () => ({ mutateAsync: ensureMutateAsyncMock }),
}));

import { Diurnal } from "../Diurnal";

function editorState(overrides: Record<string, unknown> = {}) {
  return {
    isLoading: false,
    error: null,
    isDraft: false,
    initialValue: [{ type: "paragraph", children: [{ text: "" }] }],
    editorRevision: 0,
    title: "",
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
    bodyMarkdown: "",
    kind: null,
    inferred: true,
    project: null,
    ...overrides,
  };
}

describe("Diurnal create-on-first-write", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders an editable editor for an unwritten today", () => {
    usePageEditorMock.mockReturnValue(editorState({ isDraft: true }));
    render(<Diurnal />);

    // Bound to today's deterministic path with an ensure callback,
    // without any journal-today fetch.
    const [path, options] = usePageEditorMock.mock.calls[0];
    expect(path).toMatch(/^journals\/\d{4}-\d{2}-\d{2}\.md$/);
    expect(typeof options?.ensure).toBe("function");

    expect(screen.getByTestId("slate-editor")).toBeInTheDocument();
    expect(screen.getByText("unwritten")).toBeInTheDocument();
  });

  it("shows written state once the journal exists", () => {
    usePageEditorMock.mockReturnValue(editorState({ isDraft: false }));
    render(<Diurnal />);
    expect(screen.getByTestId("slate-editor")).toBeInTheDocument();
    expect(screen.getByText("written")).toBeInTheDocument();
  });
});
