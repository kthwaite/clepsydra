import { act, renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import { createEditor, type Descendant } from "slate";
import { ReactEditor, withReact } from "slate-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type TodayJournalTarget,
  useFolioTab,
  useTodayJournal,
} from "#/components/codex/useFolioTab";
import type { CustomEditor } from "#/editor/types";
import { todayAiJournalPath, todayJournalPath } from "#/lib/journal";
import { useWorkspaceStore } from "#/store/workspace";

const journalToday = vi.hoisted(() => ({
  data: undefined as TodayJournalTarget | undefined,
  isLoading: false,
  enabled: [] as boolean[],
}));
const aiJournalToday = vi.hoisted(() => ({
  data: undefined as TodayJournalTarget | undefined,
  isLoading: false,
  enabled: [] as boolean[],
}));

vi.mock("#/api/journal", () => ({
  useJournalToday: (enabled: boolean) => {
    journalToday.enabled.push(enabled);
    return enabled
      ? { data: journalToday.data, isLoading: journalToday.isLoading }
      : { data: undefined, isLoading: false };
  },
}));
vi.mock("#/api/aiJournal", () => ({
  useAiJournalToday: (enabled: boolean) => {
    aiJournalToday.enabled.push(enabled);
    return enabled
      ? { data: aiJournalToday.data, isLoading: aiJournalToday.isLoading }
      : { data: undefined, isLoading: false };
  },
}));

const TAB = "t1";
const PATH = "notes/a.md";

type Props = {
  path: string;
  title: string;
  pageId: string | null;
  todayJournal: TodayJournalTarget | null | undefined;
  conversationReadOnly: boolean;
};

const PROPS: Props = {
  path: PATH,
  title: "",
  pageId: null,
  todayJournal: undefined,
  conversationReadOnly: false,
};

function setup(
  initialProps: Partial<Props> = {},
  body: HTMLDivElement | null = null,
  editor: CustomEditor | null = null,
) {
  const bodyRef: RefObject<HTMLDivElement | null> = { current: body };
  const folioEditorRef: RefObject<CustomEditor | null> = { current: editor };
  return renderHook(
    (props: Props) =>
      useFolioTab({
        tabId: TAB,
        path: props.path,
        editor: {
          pageId: props.pageId,
          title: props.title,
          isLoading: false,
          isEditorSynchronized: true,
        },
        todayJournal: props.todayJournal,
        conversationReadOnly: props.conversationReadOnly,
        bodyRef,
        folioEditorRef,
      }),
    { initialProps: { ...PROPS, ...initialProps } },
  );
}

const tab = () =>
  useWorkspaceStore.getState().tabs.find((candidate) => candidate.id === TAB);

function requestFocus(blockId: string) {
  useWorkspaceStore.setState({
    tabs: [
      {
        ...(tab() ?? { id: TAB, type: "page", label: "a" }),
        focusBlockId: blockId,
        focusRequestId: "req-1",
      },
    ],
  });
}

function blockBody(blockId: string) {
  const body = document.createElement("div");
  const block = document.createElement("p");
  block.dataset.blockId = blockId;
  block.scrollIntoView = vi.fn();
  body.append(block);
  document.body.append(body);
  return { body, block };
}

describe("useFolioTab", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      tabs: [{ id: TAB, type: "page", path: PATH, label: "a" }],
      activeTabId: TAB,
      quires: {},
    });
  });

  it("records the page id and title on its tab", () => {
    const { rerender } = setup();
    expect(tab()?.pageId).toBeUndefined();
    rerender({ ...PROPS, pageId: "page-1", title: "Alpha" });
    expect(tab()).toMatchObject({ pageId: "page-1", label: "Alpha" });
  });

  it("reports whether its tab is active", () => {
    const { result } = setup();
    expect(result.current.isActiveTab).toBe(true);
    act(() => useWorkspaceStore.setState({ activeTabId: "other" }));
    expect(result.current.isActiveTab).toBe(false);
  });

  it("repoints the tab to today's journal once it resolves", () => {
    const { rerender } = setup();
    rerender({
      ...PROPS,
      todayJournal: {
        path: "journals/2026-10-07.md",
        meta: { title: "Oct 7" },
      },
    });
    expect(tab()).toMatchObject({
      path: "journals/2026-10-07.md",
      label: "Oct 7",
    });
  });

  it("leaves the tab alone when today's journal is this page", () => {
    setup({ todayJournal: { path: PATH, meta: { title: "Same" } } });
    expect(tab()).toMatchObject({ path: PATH, label: "a" });
  });

  it("follows a move to a new path only", () => {
    const { result } = setup();
    act(() => result.current.followMove({ path: PATH }));
    expect(tab()?.path).toBe(PATH);
    act(() => result.current.followMove({ path: "projects/a.md" }));
    expect(tab()?.path).toBe("projects/a.md");
  });

  it("focuses the requested block's element in a read-only body", () => {
    const { body, block } = blockBody("b1");
    requestFocus("b1");
    setup({ conversationReadOnly: true }, body);
    expect(block.scrollIntoView).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(block);
    expect(block.hasAttribute("tabindex")).toBe(false);
    expect(tab()?.focusRequestId).toBeUndefined();
    body.remove();
  });

  it("puts the caret at the requested block in an editable body", () => {
    const focus = vi.spyOn(ReactEditor, "focus").mockImplementation(() => {});
    const editor = withReact(createEditor()) as CustomEditor;
    editor.children = [
      { type: "paragraph", children: [{ text: "first" }] },
      { type: "paragraph", blockId: "b1", children: [{ text: "second" }] },
    ] as Descendant[];
    const { body } = blockBody("b1");
    requestFocus("b1");
    setup({}, body, editor);
    expect(editor.selection?.anchor).toEqual({ path: [1, 0], offset: 0 });
    expect(focus).toHaveBeenCalledWith(editor);
    focus.mockRestore();
    body.remove();
  });
});

describe("useTodayJournal", () => {
  beforeEach(() => {
    for (const query of [journalToday, aiJournalToday]) {
      query.data = undefined;
      query.isLoading = false;
      query.enabled = [];
    }
  });

  it("queries nothing for an ordinary page", () => {
    const { result } = renderHook(() => useTodayJournal(PATH));
    expect(result.current).toEqual({ pending: false, target: undefined });
    expect(journalToday.enabled).toEqual([false]);
    expect(aiJournalToday.enabled).toEqual([false]);
  });

  it("is pending while today's journal loads", () => {
    journalToday.isLoading = true;
    const { result } = renderHook(() => useTodayJournal(todayJournalPath()));
    expect(result.current.pending).toBe(true);
  });

  it("targets today's journal once it resolves", () => {
    journalToday.data = { path: "journals/x.md", meta: { title: "X" } };
    const { result } = renderHook(() => useTodayJournal(todayJournalPath()));
    expect(result.current).toEqual({
      pending: true,
      target: journalToday.data,
    });
  });

  it("targets today's AI journal on its draft path", () => {
    aiJournalToday.data = { path: "ai/x.md", meta: { title: null } };
    const { result } = renderHook(() => useTodayJournal(todayAiJournalPath()));
    expect(result.current).toEqual({
      pending: true,
      target: aiJournalToday.data,
    });
  });
});
