import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Descendant } from "slate";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { markdownToSlate, slateToMarkdown } from "#/editor/convert";
import { serializeRecipeMarkdown } from "#/recipe/recipeCodec";

const canonicalRecipeMarkdown =
  "A bright dish.\n\nINGREDIENTS\n• one lemon\n• 200 g pasta\n\nSTEPS\n1. Boil the pasta.\n2. Toss and serve.\n\nNOTES\nFinish with **pepper**.\n";

const {
  mobileLayoutState,
  navigateMock,
  routerHistory,
  useCollapsibleRailMock,
  usePageEditorMock,
} = vi.hoisted(() => ({
  mobileLayoutState: { matches: false },
  navigateMock: vi.fn(),
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
  usePageEditorMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => ({ status: "idle" }),
  useNavigate: () => navigateMock,
  useRouter: () => ({ history: routerHistory }),
}));
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => vi.fn() }));
vi.mock("#/editor/usePageEditor", () => ({ usePageEditor: usePageEditorMock }));
vi.mock("#/hooks/useMobileLayout", () => ({
  useMobileLayout: () => mobileLayoutState.matches,
}));
vi.mock("#/components/codex/useCollapsibleRail", () => ({
  useCollapsibleRail: useCollapsibleRailMock,
}));
vi.mock("#/components/codex/useScrollSpy", () => ({
  useScrollSpy: () => ({ activeIndex: -1, scrollTo: vi.fn() }),
}));
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
}));
vi.mock("#/api/journal", () => ({
  useJournalToday: () => ({ data: null, isLoading: false }),
  useJournalEditorOptions: () => undefined,
  useJournalRecent: () => ({ data: [] }),
}));
vi.mock("#/lib/useProjects", () => ({ useProjects: () => [] }));
vi.mock("#/crypto/EncryptionProvider", () => ({
  useOptionalEncryptionActions: () => ({ lock: vi.fn() }),
  useEncryptionActions: () => ({
    unlockWithPassword: vi.fn(),
    unlockWithImportedIdentity: vi.fn(),
  }),
}));
vi.mock("#/api/encryption", () => ({
  useEncryptionConfig: () => ({
    data: { initialized: true, wrapped_identity: "wrapped" },
    isPending: false,
    error: null,
  }),
}));
vi.mock("#/editor/SlateEditor", () => ({
  SlateEditor: ({
    initialValue,
    onChange,
    onSaveNow,
    readOnly = false,
  }: {
    initialValue: Descendant[];
    onChange: (value: Descendant[], editor: never) => void;
    onSaveNow: () => Promise<void>;
    readOnly?: boolean;
  }) => (
    <div data-testid="slate-editor" data-readonly={String(readOnly)}>
      <textarea
        aria-label="Page body"
        readOnly={readOnly}
        defaultValue={slateToMarkdown(initialValue)}
        onChange={(event) =>
          onChange(markdownToSlate(event.currentTarget.value), {} as never)
        }
      />
      <button type="button" onClick={() => void onSaveNow()}>
        Editor save
      </button>
    </div>
  ),
}));

import { useWorkspaceStore } from "#/store/workspace";
import { Folio } from "../Folio";

interface EditorHarness {
  [key: string]: unknown;
  bodyMarkdown: string;
  onSlateChange: Mock;
  revisionConflict: unknown;
  saveError: string | null;
  saveNow: Mock;
  saveStatus: string;
  setBodyMarkdown: Mock;
}

function pageEditor(overrides: Record<string, unknown> = {}): EditorHarness {
  const body =
    (overrides.bodyMarkdown as string | undefined) ?? canonicalRecipeMarkdown;
  const initialValue =
    (overrides.initialValue as Descendant[] | undefined) ??
    markdownToSlate(body);
  const editor = {
    isLoading: false,
    error: null,
    isDraft: false,
    title: "Lemon pasta",
    setTitle: vi.fn(),
    tags: ["dinner"],
    setTags: vi.fn(),
    aliases: [],
    setAliases: vi.fn(),
    saveNow: vi.fn(async () => undefined),
    saveStatus: "saved",
    saveError: null,
    revisionConflict: null,
    reloadAfterConflict: vi.fn(async () => undefined),
    kind: "RECIPE",
    bodyMarkdown: body,
    setBodyMarkdown: vi.fn(),
    conversationProvider: null,
    inferred: false,
    project: "kitchen",
    initialValue,
    editorValue: initialValue,
    onSlateChange: vi.fn(),
    editorRevision: 1,
    createdAt: "2026-08-11T00:00:00Z",
    updatedAt: "2026-08-11T00:00:00Z",
    encrypted: false,
    encryptionState: { status: "plain", body },
    pageId: "recipe-1",
    getPlaintext: vi.fn(() => body),
    getRevision: vi.fn(() => "rev-1"),
    ...overrides,
  };
  return editor;
}

function renderFolio(editor: EditorHarness, path = "recipes/lemon-pasta.md") {
  usePageEditorMock.mockReturnValue(editor);
  useWorkspaceStore.setState({
    tabs: [{ id: "t1", type: "page", path, label: "Lemon pasta" }],
    activeTabId: "t1",
  });
  return render(<Folio tabId="t1" path={path} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  usePageEditorMock.mockReset();
  mobileLayoutState.matches = false;
});

describe("Folio recipe presentation", () => {
  it("opens a parseable recipe in Read with a read-only page header", () => {
    renderFolio(pageEditor());

    expect(
      screen.getByRole("heading", { name: "Lemon pasta", level: 1 }),
    ).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Page title" })).toBeNull();
    expect(screen.getByRole("radio", { name: "Read" })).toBeChecked();
    expect(screen.getByRole("region", { name: "Ingredients" })).toBeVisible();
    expect(screen.queryByTestId("slate-editor")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Raw Markdown" }),
    ).not.toBeInTheDocument();
  });

  it("switches to structured fields and writes exact canonical Markdown", async () => {
    const user = userEvent.setup();
    const editor = pageEditor();
    renderFolio(editor);

    await user.click(screen.getByRole("radio", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Raw Markdown" })).toBeVisible();
    const description = screen.getByRole("textbox", { name: "Description" });
    fireEvent.change(description, { target: { value: "A deeper dish." } });

    expect(editor.setBodyMarkdown).toHaveBeenLastCalledWith(
      serializeRecipeMarkdown({
        description: "A deeper dish.",
        ingredients: ["one lemon", "200 g pasta"],
        steps: ["Boil the pasta.", "Toss and serve."],
        notesMarkdown: "Finish with **pepper**.",
      }),
    );
    expect(editor.setBodyMarkdown).toHaveBeenLastCalledWith(
      "A deeper dish.\n\nINGREDIENTS\n• one lemon\n• 200 g pasta\n\nSTEPS\n1. Boil the pasta.\n2. Toss and serve.\n\nNOTES\nFinish with **pepper**.\n",
    );
  });

  it("projects a successful raw Apply into structured editing without a second body mutation", async () => {
    const user = userEvent.setup();
    const editor = pageEditor();
    renderFolio(editor);

    await user.click(screen.getByRole("radio", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
      target: { value: "Stale structured draft." },
    });
    editor.setBodyMarkdown.mockClear();

    await user.click(screen.getByRole("button", { name: "Raw Markdown" }));
    expect(screen.queryByRole("radio", { name: "Read" })).toBeNull();
    const authoredRaw =
      "Authored in raw mode.\n\nINGREDIENTS\n• two lemons\n• 200 g pasta\n\nSTEPS\n1. Boil the pasta.\n2. Toss and serve.\n\nNOTES\nKeep this exact note.\n";
    fireEvent.change(screen.getByRole("textbox", { name: "Raw Markdown" }), {
      target: { value: authoredRaw },
    });
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(editor.setBodyMarkdown).toHaveBeenCalledOnce();
    expect(editor.setBodyMarkdown).toHaveBeenCalledWith(authoredRaw);
    expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
      "Authored in raw mode.",
    );
    expect(screen.getByRole("textbox", { name: "Ingredient 1" })).toHaveValue(
      "two lemons",
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
      target: { value: "Structured after raw." },
    });
    expect(editor.setBodyMarkdown).toHaveBeenLastCalledWith(
      "Structured after raw.\n\nINGREDIENTS\n• two lemons\n• 200 g pasta\n\nSTEPS\n1. Boil the pasta.\n2. Toss and serve.\n\nNOTES\nKeep this exact note.\n",
    );
  });

  it("projects a failed raw Apply before stale structured recipe state can overwrite it", async () => {
    const user = userEvent.setup();
    const editor = pageEditor();
    renderFolio(editor);

    await user.click(screen.getByRole("radio", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
      target: { value: "Stale structured fields." },
    });
    editor.setBodyMarkdown.mockClear();

    await user.click(screen.getByRole("button", { name: "Raw Markdown" }));
    const authoredRaw = "Exact authored raw body without recipe sections.\n";
    fireEvent.change(screen.getByRole("textbox", { name: "Raw Markdown" }), {
      target: { value: authoredRaw },
    });
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(editor.setBodyMarkdown).toHaveBeenCalledOnce();
    expect(editor.setBodyMarkdown).toHaveBeenCalledWith(authoredRaw);
    expect(screen.queryByRole("textbox", { name: "Description" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Ingredient 1" })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "recipe structure could not be read",
    );
    expect(editor.setBodyMarkdown).toHaveBeenCalledTimes(1);
    expect(editor.setBodyMarkdown).toHaveBeenLastCalledWith(authoredRaw);
  });

  it("rejects raw Apply if the recipe presentation is no longer editable", async () => {
    const user = userEvent.setup();
    const editor = pageEditor();
    const rendered = renderFolio(editor);

    await user.click(screen.getByRole("radio", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Raw Markdown" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Raw Markdown" }), {
      target: { value: "Keep this raw draft exactly.\n" },
    });

    const noLongerStructured = pageEditor({
      bodyMarkdown: "No recipe sections remain.",
    });
    usePageEditorMock.mockReturnValue(noLongerStructured);
    rendered.rerender(<Folio tabId="t1" path="recipes/lemon-pasta.md" />);
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(noLongerStructured.setBodyMarkdown).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Raw Markdown" })).toHaveValue(
      "Keep this raw draft exactly.\n",
    );
    expect(screen.getByText(/no longer editable/i)).toBeVisible();
  });

  it("keeps a new empty row available for input while omitting it from Markdown", async () => {
    const user = userEvent.setup();
    const editor = pageEditor();
    renderFolio(editor);

    await user.click(screen.getByRole("radio", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Add ingredient" }));

    expect(screen.getByRole("textbox", { name: "Ingredient 3" })).toHaveFocus();
    expect(editor.setBodyMarkdown).toHaveBeenLastCalledWith(
      canonicalRecipeMarkdown,
    );
  });

  it("saves from the keyboard after a structured edit", async () => {
    const user = userEvent.setup();
    const editor = pageEditor();
    renderFolio(editor);

    await user.click(screen.getByRole("radio", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
      target: { value: "Changed." },
    });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });

    await waitFor(() => expect(editor.saveNow).toHaveBeenCalledOnce());
  });

  it("preserves and edits malformed Markdown only through the Slate boundary", () => {
    const malformed = "Keep this exact body without recipe sections.\n";
    const editedMalformed =
      "Keep this exact body without recipe sections.\nStill malformed.\n";
    const editor = pageEditor({
      bodyMarkdown: malformed,
      initialValue: markdownToSlate(malformed),
    });
    renderFolio(editor);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("original Markdown is preserved");
    expect(alert).toHaveTextContent(
      "Ingredients, Steps, and Notes once and in that order",
    );
    expect(alert).toHaveTextContent("bullet ingredients and numbered steps");
    expect(alert).toHaveTextContent("uppercase markers");
    expect(alert).toHaveTextContent("consistent Markdown headings and lists");
    const fallback = screen.getByRole("textbox", { name: "Page body" });
    expect(fallback).toHaveValue(malformed);
    expect(editor.setBodyMarkdown).not.toHaveBeenCalled();

    fireEvent.change(fallback, { target: { value: editedMalformed } });
    expect(editor.onSlateChange).toHaveBeenCalledOnce();
    expect(
      slateToMarkdown(editor.onSlateChange.mock.calls[0]?.[0] as Descendant[]),
    ).toBe(editedMalformed);
    expect(editor.setBodyMarkdown).not.toHaveBeenCalled();
  });

  it("keeps a revision conflict visible without resetting structured edit mode", async () => {
    const user = userEvent.setup();
    const editor = pageEditor();
    const view = renderFolio(editor);

    await user.click(screen.getByRole("radio", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
      target: { value: "Local conflict draft." },
    });
    expect(editor.setBodyMarkdown).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "Description" })).toBeVisible();

    editor.revisionConflict = {
      expectedRevision: "rev-1",
      actualRevision: "rev-2",
    } as never;
    editor.saveStatus = "error";
    editor.saveError = "conflict" as never;
    view.rerender(<Folio tabId="t1" path="recipes/lemon-pasta.md" />);

    expect(screen.getByText("Page changed on disk")).toBeVisible();
    expect(screen.getByRole("radio", { name: "Edit" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
      "Local conflict draft.",
    );
    expect(editor.setBodyMarkdown).toHaveBeenCalledOnce();
  });

  it("resets to Read and reparses when the path changes", async () => {
    const user = userEvent.setup();
    const first = pageEditor();
    const second = pageEditor({
      title: "Tomato soup",
      bodyMarkdown:
        "A warming soup.\n\nINGREDIENTS\n• tomatoes\n\nSTEPS\n1. Simmer.\n\nNOTES\nServe hot.\n",
    });
    usePageEditorMock.mockImplementation((path: string) =>
      path === "recipes/tomato-soup.md" ? second : first,
    );
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "t1",
          type: "page",
          path: "recipes/lemon-pasta.md",
          label: "Lemon pasta",
        },
      ],
      activeTabId: "t1",
    });
    const view = render(<Folio tabId="t1" path="recipes/lemon-pasta.md" />);
    await user.click(screen.getByRole("radio", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
      target: { value: "Only page one." },
    });
    expect(first.setBodyMarkdown).toHaveBeenCalledOnce();

    view.rerender(<Folio tabId="t1" path="recipes/tomato-soup.md" />);

    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Read" })).toBeChecked(),
    );
    expect(screen.getByText("A warming soup.")).toBeVisible();
    expect(screen.getByText("tomatoes")).toBeVisible();
    expect(screen.queryByText("Only page one.")).toBeNull();
    expect(first.setBodyMarkdown).toHaveBeenCalledOnce();
    expect(second.setBodyMarkdown).not.toHaveBeenCalled();
  });

  it("reparses a new editor revision without normalizing the transition", async () => {
    const user = userEvent.setup();
    const editor = pageEditor();
    const view = renderFolio(editor);

    await user.click(screen.getByRole("radio", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
      target: { value: "Stale local draft." },
    });
    expect(editor.setBodyMarkdown).toHaveBeenCalledOnce();

    const reloadedMarkdown =
      "Server revision.\n\nINGREDIENTS\n• fresh ingredient\n\nSTEPS\n1. Start again.\n\nNOTES\nReloaded.\n";
    editor.bodyMarkdown = reloadedMarkdown;
    editor.initialValue = markdownToSlate(reloadedMarkdown);
    editor.editorValue = markdownToSlate(reloadedMarkdown);
    editor.editorRevision = 2;
    view.rerender(<Folio tabId="t1" path="recipes/lemon-pasta.md" />);

    expect(screen.getByRole("radio", { name: "Edit" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
      "Server revision.",
    );
    expect(screen.getByRole("textbox", { name: "Ingredient 1" })).toHaveValue(
      "fresh ingredient",
    );
    expect(editor.setBodyMarkdown).toHaveBeenCalledOnce();
  });

  it("renders a locked encrypted Folio before recipe controls", () => {
    const editor = pageEditor({
      encrypted: true,
      encryptionState: { status: "locked" },
    });
    renderFolio(editor);

    expect(screen.getByRole("heading", { name: "Lemon pasta" })).toBeVisible();
    expect(screen.getByLabelText("Encryption password")).toBeVisible();
    expect(
      screen.queryByRole("radiogroup", { name: "Recipe mode" }),
    ).toBeNull();
    expect(editor.setBodyMarkdown).not.toHaveBeenCalled();
  });
});
