import { type RefObject, useEffect } from "react";
import { Editor, Element as SlateElement, Transforms } from "slate";
import { ReactEditor } from "slate-react";
import { useAiJournalToday } from "#/api/aiJournal";
import { useJournalToday } from "#/api/journal";
import type { CustomEditor } from "#/editor/types";
import type { PageEditorState } from "#/editor/usePageEditor";
import { todayAiJournalPath, todayJournalPath } from "#/lib/journal";
import { useWorkspaceStore } from "#/store/workspace";

/** The real page behind a today's-journal draft path. */
export type TodayJournalTarget = {
  path: string;
  meta: { title?: string | null };
};

/** Resolves a today's-journal (or AI journal) draft path to its real page.
 *  `pending` holds the Folio body until the tab is repointed there. */
export function useTodayJournal(path: string): {
  pending: boolean;
  target: TodayJournalTarget | null | undefined;
} {
  const isTodayDraftPath = path === todayJournalPath();
  const { data: journalToday, isLoading: isJournalTodayLoading } =
    useJournalToday(isTodayDraftPath);
  const isTodayAiDraftPath = path === todayAiJournalPath();
  const { data: aiJournalToday, isLoading: isAiJournalTodayLoading } =
    useAiJournalToday(isTodayAiDraftPath);
  return {
    pending: Boolean(
      (isTodayDraftPath && (isJournalTodayLoading || journalToday)) ||
        (isTodayAiDraftPath && (isAiJournalTodayLoading || aiJournalToday)),
    ),
    target: isTodayDraftPath
      ? journalToday
      : isTodayAiDraftPath
        ? aiJournalToday
        : undefined,
  };
}

type FolioTabOptions = {
  tabId: string;
  path: string;
  editor: Pick<
    PageEditorState,
    "pageId" | "title" | "isLoading" | "isEditorSynchronized"
  >;
  todayJournal: TodayJournalTarget | null | undefined;
  /** The body is a read-only conversation, so a focus request lands on the
   *  block's element instead of the Slate caret. */
  conversationReadOnly: boolean;
  bodyRef: RefObject<HTMLDivElement | null>;
  folioEditorRef: RefObject<CustomEditor | null>;
};

/** Keeps the workspace tab hosting a Folio in step with its page. */
export function useFolioTab({
  tabId,
  path,
  editor,
  todayJournal,
  conversationReadOnly,
  bodyRef,
  folioEditorRef,
}: FolioTabOptions) {
  const updateTabLabel = useWorkspaceStore((s) => s.updateTabLabel);
  const updateTabPath = useWorkspaceStore((s) => s.updateTabPath);
  const setTabPageId = useWorkspaceStore((state) => state.setTabPageId);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const tabQuire = useWorkspaceStore((s) => {
    const quireId = s.tabs.find((tab) => tab.id === tabId)?.quireId;
    return quireId ? s.quires[quireId] : undefined;
  });
  const focusRequestId = useWorkspaceStore(
    (state) => state.tabs.find((tab) => tab.id === tabId)?.focusRequestId,
  );
  const takeTabFocus = useWorkspaceStore((state) => state.takeTabFocus);
  const isActiveTab = useWorkspaceStore((s) => s.activeTabId === tabId);

  useEffect(() => {
    if (editor.pageId) setTabPageId(tabId, editor.pageId);
  }, [editor.pageId, setTabPageId, tabId]);

  useEffect(() => {
    if (todayJournal?.path && todayJournal.path !== path) {
      updateTabPath(
        tabId,
        todayJournal.path,
        todayJournal.meta.title ?? undefined,
      );
    }
  }, [todayJournal, path, tabId, updateTabPath]);

  useEffect(() => {
    if (editor.title) updateTabLabel(tabId, editor.title);
  }, [tabId, editor.title, updateTabLabel]);

  useEffect(() => {
    if (!focusRequestId || editor.isLoading || !editor.isEditorSynchronized) {
      return;
    }
    const focusBlockId = takeTabFocus(tabId, focusRequestId);
    if (!focusBlockId) return;

    const target = Array.from(
      bodyRef.current?.querySelectorAll<HTMLElement>("[data-block-id]") ?? [],
    ).find((element) => element.dataset.blockId === focusBlockId);
    if (!target) return;

    target.scrollIntoView({ block: "center", inline: "nearest" });
    if (!conversationReadOnly && folioEditorRef.current) {
      const editorInstance = folioEditorRef.current;
      const entry = Editor.nodes(editorInstance, {
        at: [],
        match: (node) =>
          SlateElement.isElement(node) &&
          node.type !== "block-ref" &&
          "blockId" in node &&
          node.blockId === focusBlockId,
      }).next().value;
      if (entry) {
        Transforms.select(
          editorInstance,
          Editor.start(editorInstance, entry[1]),
        );
        ReactEditor.focus(editorInstance);
      }
      return;
    }

    const hadTabIndex = target.hasAttribute("tabindex");
    if (!hadTabIndex) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    if (!hadTabIndex) target.removeAttribute("tabindex");
  }, [
    bodyRef,
    conversationReadOnly,
    editor.isLoading,
    editor.isEditorSynchronized,
    focusRequestId,
    folioEditorRef,
    tabId,
    takeTabFocus,
  ]);

  // Assigning a kind/project writes frontmatter AND moves the file, so the
  // page path changes. Repoint the open tab to the new path; because FOLIO is
  // keyed on the tab path (TabContent), this remounts the editor at the new
  // location — the entire follow mechanism.
  const followMove = (data: { path?: string }) => {
    if (data.path && data.path !== path) updateTabPath(tabId, data.path);
  };

  return { tabQuire, isActiveTab, updateTabPath, closeTab, followMove };
}
