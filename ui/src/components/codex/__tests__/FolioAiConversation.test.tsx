import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useMemo, useRef, useState } from "react";
import { createEditor, type Descendant, type Editor, Node } from "slate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./FolioProperties.mock";
import { Select, SelectItem } from "#/components/ui/select";
import { useConversationPresentation } from "#/editor/conversation/presentation";
import { markdownToSlate, slateToMarkdown } from "#/editor/convert";
import type { CustomEditor } from "#/editor/types";

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const canonicalConversationMarkdown = `> [!AI-USER source=sha256:${HASH} sequence=1]\n> A question\n\n> [!AI-ASSISTANT source=sha256:${HASH} sequence=2]\n> An answer`;

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
  useRouterState: ({
    select,
  }: {
    select: (s: {
      matches: Array<{ staticData?: { codexView?: string } }>;
    }) => unknown;
  }) => select({ matches: [{ staticData: { codexView: "workspace" } }] }),
}));
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
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock("#/api/pages", () => ({
  useAssignPage: () => ({ mutate: vi.fn() }),
  useArchivePage: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
    editorRef,
  }: {
    initialValue: Descendant[];
    onChange: (value: Descendant[], editor: Editor) => void;
    onSaveNow: () => Promise<void>;
    readOnly?: boolean;
    editorRef?: { current: CustomEditor | null };
  }) => {
    const presentation = useConversationPresentation();
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const editor = useMemo(() => createEditor() as CustomEditor, []);
    const [value, setValue] = useState<Descendant[]>(initialValue);

    useEffect(() => {
      editor.children = initialValue;
      setValue(initialValue);
    }, [editor, initialValue]);
    useEffect(() => {
      editor.onChange = () => {
        const next = [...editor.children] as Descendant[];
        setValue(next);
        onChangeRef.current(next, editor);
      };
      if (editorRef) editorRef.current = editor;
      return () => {
        if (editorRef?.current === editor) editorRef.current = null;
      };
    }, [editor, editorRef]);

    return (
      <div
        data-testid="slate-editor"
        data-readonly={String(readOnly)}
        data-mode={presentation.mode}
      >
        {presentation.mode === "generic"
          ? value.map((node, index) => {
              if ("type" in node && node.type === "conversation-turn") {
                const marker = slateToMarkdown([node])
                  .split("\n", 1)[0]
                  .replace(/^> /, "");
                return (
                  <blockquote key={index}>
                    <span>{marker}</span>
                    <textarea
                      aria-label="Page body"
                      value={Node.string(node)}
                      onChange={(event) => {
                        const next = [...editor.children] as Descendant[];
                        next[index] = {
                          ...node,
                          children: [
                            {
                              type: "paragraph",
                              children: [{ text: event.currentTarget.value }],
                            },
                          ],
                        };
                        editor.children = next;
                        editor.onChange();
                      }}
                    />
                  </blockquote>
                );
              }
              return null;
            })
          : null}
        {presentation.mode !== "generic"
          ? value.map((node, index) => {
              if ("type" in node && node.type === "conversation-turn") {
                const role = node.role as "user" | "assistant";
                const provider = presentation.provider?.trim().toLowerCase();
                const assistant =
                  provider === "claude" ? "Claude" : "Assistant";
                return (
                  <article key={`${role}-${index}`} data-role={role}>
                    <span>{role === "user" ? "You" : assistant}</span>
                    {!readOnly ? (
                      <div>
                        <Select
                          aria-label="Change participant"
                          value={role}
                          onChange={(key) => {
                            if (key === null) return;
                            const next = [...editor.children] as Descendant[];
                            next[index] = {
                              ...node,
                              role: String(key) as "user" | "assistant",
                            };
                            editor.children = next;
                            editor.onChange();
                          }}
                        >
                          <SelectItem id="user">You</SelectItem>
                          <SelectItem
                            id="assistant"
                            textValue={assistant}
                          >
                            {assistant}
                          </SelectItem>
                        </Select>
                        <button type="button" aria-label="Add turn after">
                          +
                        </button>
                      </div>
                    ) : null}
                    <textarea
                      aria-label={`Turn ${index + 1}`}
                      readOnly={readOnly}
                      value={Node.string(node)}
                      onChange={(event) => {
                        if (readOnly) return;
                        const next = [...editor.children] as Descendant[];
                        next[index] = {
                          ...node,
                          children: [
                            {
                              type: "paragraph",
                              children: [{ text: event.currentTarget.value }],
                            },
                          ],
                        };
                        editor.children = next;
                        editor.onChange();
                      }}
                    />
                  </article>
                );
              }
              return (
                <textarea
                  key={index}
                  aria-label="Page body"
                  readOnly={readOnly}
                  value={Node.string(node)}
                  onChange={(event) => {
                    if (readOnly) return;
                    const next = [...editor.children] as Descendant[];
                    next[index] = {
                      type: "paragraph",
                      children: [{ text: event.currentTarget.value }],
                    };
                    editor.children = next;
                    editor.onChange();
                  }}
                />
              );
            })
          : null}
        <button type="button" onClick={() => void onSaveNow()}>
          Editor save
        </button>
      </div>
    );
  },
}));

import { useWorkspaceStore } from "#/store/workspace";
import { Folio } from "../Folio";

interface EditorHarness {
  editorValue: Descendant[];
  initialValue: Descendant[];
  onSlateChange: ReturnType<typeof vi.fn>;
  saveNow: ReturnType<typeof vi.fn>;
  savedMarkdown: () => string | null;
  [key: string]: unknown;
}

function pageEditor(overrides: Record<string, unknown> = {}): EditorHarness {
  const body =
    (overrides.bodyMarkdown as string | undefined) ??
    canonicalConversationMarkdown;
  const initialValue =
    (overrides.initialValue as Descendant[] | undefined) ??
    markdownToSlate(body);
  let editorValue = initialValue;
  let saved: string | null = null;
  const onSlateChange = vi.fn((value: Descendant[]) => {
    editorValue = value;
  });
  const saveNow = vi.fn(async () => {
    saved = slateToMarkdown(editorValue);
  });
  return {
    isLoading: false,
    error: null,
    isDraft: false,
    title: "Conversation",
    setTitle: vi.fn(),
    tags: [],
    setTags: vi.fn(),
    aliases: [],
    setAliases: vi.fn(),
    saveNow,
    saveStatus: "saved",
    saveError: null,
    revisionConflict: null,
    reloadAfterConflict: vi.fn(),
    kind: "AI_CONVERSATION",
    bodyMarkdown: body,
    conversationProvider: "claude",
    inferred: false,
    project: null,
    initialValue,
    get editorValue() {
      return editorValue;
    },
    onSlateChange,
    editorRevision: 1,
    createdAt: "2026-08-09T00:00:00Z",
    updatedAt: "2026-08-09T00:00:00Z",
    encrypted: false,
    encryptionState: { status: "plain", body },
    pageId: "conversation-1",
    getPlaintext: vi.fn(() => body),
    getRevision: vi.fn(() => "rev-1"),
    setBodyMarkdown: vi.fn(),
    savedMarkdown: () => saved,
    ...overrides,
  };
}

function renderFolio(editor: EditorHarness, path = "conversations/one.md") {
  usePageEditorMock.mockReturnValue(editor);
  useWorkspaceStore.setState({
    tabs: [{ id: "t1", type: "page", path, label: "Conversation" }],
    activeTabId: "t1",
  });
  return render(<Folio tabId="t1" path={path} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mobileLayoutState.matches = false;
});

describe("Folio AI conversation presentation", () => {
  it("defaults to Read with a read-only Slate transcript and provider labels", () => {
    const editor = pageEditor();
    renderFolio(editor);
    expect(screen.getByRole("button", { name: "Read" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("slate-editor")).toHaveAttribute(
      "data-readonly",
      "true",
    );
    expect(screen.getByText("You")).toBeVisible();
    expect(screen.getByText("Claude")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Turn 1" }), {
      target: { value: "Read mode mutation" },
    });
    const browserHandled = fireEvent.keyDown(window, {
      key: "s",
      ctrlKey: true,
    });
    expect(browserHandled).toBe(false);
    expect(editor.onSlateChange).not.toHaveBeenCalled();
    expect(editor.saveNow).not.toHaveBeenCalled();
  });

  it("renders all page mutation surfaces as noninteractive values in Read", async () => {
    const user = userEvent.setup();
    const editor = pageEditor({
      tags: ["research"],
      aliases: ["thread"],
      project: "atlas",
    });
    renderFolio(editor);

    expect(screen.getByRole("heading", { name: "Conversation" })).toBeVisible();
    expect(screen.getByText("research")).toBeVisible();
    expect(screen.getByText("thread")).toBeVisible();
    expect(screen.getByText("atlas")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Page title" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Add tags" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Kind" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Project" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /plaintext · protect/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Manage attachments" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage paths" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Raw Markdown" }),
    ).not.toBeInTheDocument();
    expect(editor.setTitle).not.toHaveBeenCalled();
    expect(editor.setTags).not.toHaveBeenCalled();
    expect(editor.setAliases).not.toHaveBeenCalled();
    expect(editor.saveNow).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByRole("textbox", { name: "Page title" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Add tags" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Kind" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Project" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: /plaintext · protect/i }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Manage attachments" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Manage paths" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Raw Markdown" })).toBeVisible();
  });

  it("does not expose an edit-to-Read transition while raw mode is active", async () => {
    const user = userEvent.setup();
    const editor = pageEditor();
    renderFolio(editor);

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Raw Markdown" }));

    expect(screen.queryByRole("button", { name: "Read" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Raw Markdown" }), {
      target: { value: `${canonicalConversationMarkdown}\n` },
    });
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(editor.setBodyMarkdown).toHaveBeenCalledOnce();
  });

  it("enables transcript role and action controls only in Edit", async () => {
    const user = userEvent.setup();
    renderFolio(pageEditor());
    expect(
      screen.queryAllByRole("button", { name: /Change participant/ }),
    ).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByTestId("slate-editor")).toHaveAttribute(
      "data-readonly",
      "false",
    );
    expect(
      screen.getAllByRole("button", { name: /Change participant/ }),
    ).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: "Add turn after" }),
    ).toHaveLength(2);
  });

  it("adds a local assistant turn through the editor ref", async () => {
    const user = userEvent.setup();
    const editor = pageEditor({
      bodyMarkdown: "",
      initialValue: markdownToSlate(""),
    });
    renderFolio(editor);
    const modes = within(
      screen.getByRole("group", { name: "Conversation mode" }),
    );
    await user.click(modes.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Add turn" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Turn 2" })).toBeVisible(),
    );
    expect(editor.onSlateChange).toHaveBeenCalled();
  });

  it("preserves unsaved Slate state when returning to Read", async () => {
    const user = userEvent.setup();
    const editor = pageEditor();
    renderFolio(editor);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const assistantTurn = screen.getByRole("textbox", { name: "Turn 2" });
    await user.clear(assistantTurn);
    await user.type(assistantTurn, "A revised answer");
    await user.click(screen.getByRole("button", { name: "Read" }));
    expect(screen.getByRole("textbox", { name: "Turn 2" })).toHaveValue(
      "A revised answer",
    );
    expect(editor.saveNow).not.toHaveBeenCalled();
  });

  it("saves edited turns with canonical markers", async () => {
    const user = userEvent.setup();
    const editor = pageEditor();
    renderFolio(editor);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const assistantTurn = screen.getByRole("textbox", { name: "Turn 2" });
    await user.clear(assistantTurn);
    await user.type(assistantTurn, "A revised answer");
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(editor.saveNow).toHaveBeenCalledOnce());
    expect(editor.savedMarkdown()).toContain(
      `> [!AI-ASSISTANT source=sha256:${HASH} sequence=2]`,
    );
    expect(editor.savedMarkdown()).toContain("> A revised answer");
  });

  it("shows malformed marker text with a warning and an Edit recovery action", async () => {
    const user = userEvent.setup();
    const malformed =
      "> [!AI-ASSISTANT source=sha256:not-a-hash sequence=2]\n> keep this text";
    renderFolio(pageEditor({ bodyMarkdown: malformed }));
    expect(screen.getByRole("alert")).toHaveTextContent("marker");
    expect(screen.getByText(/keep this text/)).toBeVisible();
    await user.click(
      within(screen.getByRole("alert")).getByRole("button", { name: "Edit" }),
    );
    expect(
      within(
        screen.getByRole("group", { name: "Conversation mode" }),
      ).getByRole("button", { name: "Edit" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("warns when an assigned AI page has no valid markers", () => {
    renderFolio(
      pageEditor({ bodyMarkdown: "Ordinary markdown remains visible" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /no valid conversation markers/i,
    );
    expect(screen.getByText("Ordinary markdown remains visible")).toBeVisible();
  });

  it("resets the mode to Read when the page changes", async () => {
    const user = userEvent.setup();
    const rendered = renderFolio(pageEditor(), "conversations/one.md");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    usePageEditorMock.mockReturnValue(
      pageEditor({ title: "Second conversation" }),
    );
    rendered.rerender(<Folio tabId="t1" path="conversations/two.md" />);
    expect(screen.getByRole("button", { name: "Read" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps ordinary Note and Journal Folios on their existing editor surface", () => {
    const note = pageEditor({
      kind: "NOTE",
      bodyMarkdown: "Ordinary note",
      conversationProvider: null,
    });
    const rendered = renderFolio(note, "notes/ordinary.md");
    expect(screen.queryByRole("button", { name: "Read" })).toBeNull();
    expect(screen.getByTestId("slate-editor")).toHaveAttribute(
      "data-readonly",
      "false",
    );
    const journal = pageEditor({
      kind: "JOURNAL",
      bodyMarkdown: "Journal body",
      conversationProvider: null,
    });
    usePageEditorMock.mockReturnValue(journal);
    rendered.rerender(<Folio tabId="t1" path="journals/2026/08/09.md" />);
    expect(screen.queryByRole("button", { name: "Read" })).toBeNull();
    expect(screen.getByTestId("slate-editor")).toHaveAttribute(
      "data-readonly",
      "false",
    );
  });

  it("opens canonical markers assigned as a Note with generic editable presentation and preserves them on save and reload", async () => {
    const user = userEvent.setup();
    const note = pageEditor({
      kind: "NOTE",
      bodyMarkdown: canonicalConversationMarkdown,
      conversationProvider: null,
    });
    renderFolio(note, "notes/imported-conversation.md");

    expect(screen.getByTestId("slate-editor")).toHaveAttribute(
      "data-mode",
      "generic",
    );
    expect(
      screen.queryByRole("group", { name: "Conversation mode" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Change participant/ }),
    ).toBeNull();
    expect(screen.queryByText("You")).toBeNull();
    expect(
      screen.getByText(`[!AI-USER source=sha256:${HASH} sequence=1]`),
    ).toBeVisible();

    const firstTurn = screen.getAllByRole("textbox", { name: "Page body" })[0];
    await user.clear(firstTurn);
    await user.type(firstTurn, "A retained question");
    await user.click(screen.getByRole("button", { name: "Editor save" }));

    const saved = note.savedMarkdown();
    expect(saved).toContain(`> [!AI-USER source=sha256:${HASH} sequence=1]`);
    expect(saved).toContain("> A retained question");
    expect(slateToMarkdown(markdownToSlate(saved ?? ""))).toBe(saved);
  });

  it("renders locked AI Folios before any transcript UI", () => {
    renderFolio(
      pageEditor({ encrypted: true, encryptionState: { status: "locked" } }),
    );
    expect(screen.queryByTestId("slate-editor")).toBeNull();
    expect(screen.queryByRole("button", { name: "Read" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Conversation" })).toBeVisible();
  });
});
