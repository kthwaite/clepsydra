import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The recovery panel is the PRIMARY (declarative) invalid-tab path: usePage
// opts out of throwOnError, so a 404 surfaces as editor.error and Folio's
// early-return branch renders FolioNotFound. Mock the editor + data hooks so
// the test isolates that branch (FolioBoundary covers the thrown-error path).
const { usePageEditorMock } = vi.hoisted(() => ({
  usePageEditorMock: vi.fn(),
}));
vi.mock("#/editor/usePageEditor", () => ({
  usePageEditor: usePageEditorMock,
}));
vi.mock("#/api/index", () => ({
  useBacklinks: () => ({ data: undefined }),
  useOutlinks: () => ({ data: undefined }),
  useSimilar: () => ({ data: undefined }),
}));
vi.mock("#/api/pages", () => ({
  useAssignPage: () => ({ mutate: vi.fn() }),
}));
vi.mock("#/api/journal", () => ({
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

describe("Folio invalid-tab recovery", () => {
  beforeEach(() => {
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
});
