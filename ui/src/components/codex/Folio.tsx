import {
  Link,
  useBlocker,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import {
  type CSSProperties,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type Descendant,
  Editor,
  type Range,
  Element as SlateElement,
  Transforms,
} from "slate";
import { ReactEditor } from "slate-react";
import { useAiJournalToday } from "#/api/aiJournal";
import {
  useBacklinks,
  useOutlinks,
  useSimilar,
  useTagSuggestions,
} from "#/api/index";
import { useJournalEditorOptions, useJournalToday } from "#/api/journal";
import { type ArchivedPage, useAssignPage } from "#/api/pages";
import type { PageMeta } from "#/api/types";
import { AiConversationControls } from "#/components/codex/AiConversationControls";
import { CLink } from "#/components/codex/CLink";
import {
  FolioError,
  resetErroredQueries,
  toError,
} from "#/components/codex/FolioError";
import { FolioNotFound } from "#/components/codex/FolioNotFound";
import { FolioProperties } from "#/components/codex/FolioProperties";
import {
  countWordsFromSlate,
  shortFolio,
  visibleFolioOutlinks,
} from "#/components/codex/folio-utils";
import { buildToc, type TocEntry } from "#/components/codex/folioToc";
import {
  highlightMatch,
  plainWikiText,
} from "#/components/codex/highlightMatch";
import { KindSelect } from "#/components/codex/KindSelect";
import { LockedFolio } from "#/components/codex/LockedFolio";
import { MobileFolioLayout } from "#/components/codex/MobileFolioLayout";
import { ProjectCombo } from "#/components/codex/ProjectCombo";
import { RawMarkdownEditor } from "#/components/codex/RawMarkdownEditor";
import { ReadingColumnResizer } from "#/components/codex/ReadingColumnResizer";
import { useSetReadingProgress } from "#/components/codex/ReadingProgressContext";
import { RecipeFolioBody } from "#/components/codex/recipe/RecipeFolioBody";
import { Section } from "#/components/codex/Section";
import { useCollapsibleRail } from "#/components/codex/useCollapsibleRail";
import { useReadingColumn } from "#/components/codex/useReadingColumn";
import { useScrollSpy } from "#/components/codex/useScrollSpy";
import { KindIcon } from "#/components/KindIcon";
import { OfflineUnavailable } from "#/components/OfflineUnavailable";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { IconButton } from "#/components/ui/icon-button";
import { TagInput } from "#/components/ui/tag-input";
import { useOptionalEncryptionActions } from "#/crypto/EncryptionProvider";
import { BaseRenderingProvider } from "#/editor/baseRendering";
import { diagnoseConversationMarkdown } from "#/editor/conversation/marker";
import { ConversationPresentationProvider } from "#/editor/conversation/presentation";
import { insertConversationTurn } from "#/editor/conversation/transforms";
import { PageEditorHeader, RawMarkdownButton } from "#/editor/PageEditorHeader";
import { SaveIndicator } from "#/editor/SaveIndicator";
import { SlateEditor } from "#/editor/SlateEditor";
import type { CustomEditor } from "#/editor/types";
import { usePageEditor } from "#/editor/usePageEditor";
import { WikilinkResolutionProvider } from "#/editor/wikilinkResolution";
import { useDebounce } from "#/hooks/useDebounce";
import {
  registerFolioHistoryTraversalGuard,
  replaceFolioHistoryAfterArchive,
  useLeaveFolioWorkspace,
} from "#/hooks/useFolioHistoryNavigation";
import { useMobileLayout } from "#/hooks/useMobileLayout";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import {
  aiJournalDateFromPath,
  journalDateFromPath,
  todayAiJournalPath,
  todayJournalPath,
} from "#/lib/journal";
import { kindDisplayLabel, kindLabel, resolveKind } from "#/lib/kind";
import { presentationFor } from "#/lib/kindPresentation";
import { formatChord, matchesChord, SHORTCUTS } from "#/lib/shortcuts";
import { formatAbsoluteDate, formatRelativeTime } from "#/lib/time";
import { useProjects } from "#/lib/useProjects";
import { isOfflineUncached } from "#/offline/swPolicy";
import {
  parseRecipeMarkdown,
  type RecipeParseResult,
  serializeRecipeMarkdown,
} from "#/recipe/recipeCodec";
import { FOLIO_LEFT_RAIL, FOLIO_RIGHT_RAIL } from "#/store/folioRails";
import {
  clearFolioRestoration,
  consumeFolioHistoryRestorationRequest,
  type FolioRestoration,
  readFolioHistoryRestorationRequest,
  readFolioHistoryRestorationRequestId,
  readFolioRestoration,
  registerFolioHistoryCapture,
  saveFolioRestoration,
  snapshotTextPoint,
  subscribeFolioHistoryRestorationRequests,
  validateTextPointSnapshot,
} from "#/store/folioRestoration";
import { useFooterContext } from "#/store/footerContext";
import {
  registerWorkspaceTransitionGuard,
  runWorkspaceTransition,
  useWorkspaceStore,
} from "#/store/workspace";

type FolioProps = {
  tabId: string;
  path: string;
};

type RawMarkdownSession = {
  path: string;
  entryRevision: string;
  snapshot: string;
  value: string;
  diagnostic: string | null;
};

function rawMarkdownApplyDiagnostic(error: unknown) {
  const detail =
    error instanceof Error && error.message.trim() ? `: ${error.message}` : "";
  return `Raw Markdown could not be applied${detail}. Fix the Markdown and try again.`;
}

function RawMarkdownNavigationGuard({
  dirty,
  onLeave,
}: {
  dirty: boolean;
  onLeave: () => void;
}) {
  const leaveApprovedRef = useRef(false);
  const blocker = useBlocker({
    shouldBlockFn: () => dirty && !leaveApprovedRef.current,
    enableBeforeUnload: dirty,
    withResolver: true,
  });
  const pendingTransitionRef = useRef<{ proceed: () => void } | null>(null);
  const [pendingTransition, setPendingTransition] = useState<{
    proceed: () => void;
  } | null>(null);

  useEffect(() => {
    if (!dirty) return;
    const guard = (proceed: () => void) => {
      if (leaveApprovedRef.current) return false;
      const pending = { proceed };
      pendingTransitionRef.current = pending;
      setPendingTransition(pending);
      leaveApprovedRef.current = false;
      return true;
    };
    const unregisterWorkspaceGuard = registerWorkspaceTransitionGuard(guard);
    const unregisterHistoryGuard = registerFolioHistoryTraversalGuard(guard);
    return () => {
      unregisterWorkspaceGuard();
      unregisterHistoryGuard();
    };
  }, [dirty]);

  const stay = () => {
    pendingTransitionRef.current = null;
    leaveApprovedRef.current = false;
    setPendingTransition(null);
    if (blocker.status === "blocked") blocker.reset?.();
  };
  const leave = () => {
    const pending = pendingTransitionRef.current;
    if (!pending && blocker.status !== "blocked") return;
    pendingTransitionRef.current = null;
    leaveApprovedRef.current = true;
    setPendingTransition(null);
    onLeave();
    if (pending) pending.proceed();
    else blocker.proceed?.();
  };

  return (
    <Dialog
      isOpen={blocker.status === "blocked" || pendingTransition !== null}
      onOpenChange={(open) => {
        if (!open) stay();
      }}
      title="Unsaved raw Markdown"
      description="Leaving now will discard the raw Markdown draft."
      footer={
        <>
          <Button variant="secondary" onPress={stay}>
            Stay
          </Button>
          <Button variant="danger" onPress={leave}>
            Leave
          </Button>
        </>
      }
    >
      <p className="text-[13.5px] text-mute">
        This raw draft exists only in this browser until you Apply it.
      </p>
    </Dialog>
  );
}

const EMPTY_EDITOR_VALUE: [] = [];

function containsBlockId(nodes: Descendant[]): boolean {
  return nodes.some(
    (node) =>
      SlateElement.isElement(node) &&
      (("blockId" in node && typeof node.blockId === "string") ||
        containsBlockId(node.children)),
  );
}

const NoteProtectionDialog = lazy(() =>
  import("#/components/codex/NoteProtectionDialog").then((module) => ({
    default: module.NoteProtectionDialog,
  })),
);

const AttachmentManager = lazy(() =>
  import("#/components/attachments/AttachmentManager").then((module) => ({
    default: module.AttachmentManager,
  })),
);

const PageActionsMenu = lazy(() =>
  import("#/components/page-tree/PageActionsMenu").then((module) => ({
    default: module.PageActionsMenu,
  })),
);

const FolderActionsMenu = lazy(() =>
  import("#/components/page-tree/FolderActionsMenu").then((module) => ({
    default: module.FolderActionsMenu,
  })),
);

export function Folio({ tabId, path }: FolioProps) {
  const mobile = useMobileLayout();
  const navigate = useNavigate();
  const router = useRouter();
  const routerHistory = router?.history;
  const leaveFolioWorkspace = useLeaveFolioWorkspace();
  const isTodayDraftPath = path === todayJournalPath();
  const { data: journalToday, isLoading: isJournalTodayLoading } =
    useJournalToday(isTodayDraftPath);
  const isTodayAiDraftPath = path === todayAiJournalPath();
  const { data: aiJournalToday, isLoading: isAiJournalTodayLoading } =
    useAiJournalToday(isTodayAiDraftPath);
  const editor = usePageEditor(path, useJournalEditorOptions(path));
  const { data: backlinks } = useBacklinks(path);
  const { data: outlinks } = useOutlinks(path);
  const visibleOutlinks = useMemo(
    () => visibleFolioOutlinks(outlinks),
    [outlinks],
  );
  const { data: similar } = useSimilar(path);
  const [tagSuggestionQuery, setTagSuggestionQuery] = useState("");
  const debouncedTagSuggestionQuery = useDebounce(tagSuggestionQuery, 200);
  const tagSuggestionEnabled = debouncedTagSuggestionQuery.length > 0;
  const tagSuggestionRequest = useTagSuggestions(
    debouncedTagSuggestionQuery,
    12,
    tagSuggestionEnabled,
  );
  const tagSuggestionsCurrent =
    tagSuggestionQuery === debouncedTagSuggestionQuery;
  const tagSuggestions = useMemo(
    () =>
      tagSuggestionsCurrent
        ? (tagSuggestionRequest.data ?? []).map(({ tag }) => tag)
        : [],
    [tagSuggestionRequest.data, tagSuggestionsCurrent],
  );
  const tagSuggestionsLoading =
    tagSuggestionQuery.length > 0 &&
    (!tagSuggestionsCurrent ||
      tagSuggestionRequest.isLoading ||
      tagSuggestionRequest.isFetching);
  const tagSuggestionsError =
    tagSuggestionsCurrent &&
    !tagSuggestionRequest.isFetching &&
    tagSuggestionRequest.error
      ? new Error(tagSuggestionRequest.error.error)
      : null;
  const updateTabLabel = useWorkspaceStore((s) => s.updateTabLabel);
  const updateTabPath = useWorkspaceStore((s) => s.updateTabPath);
  const setTabPageId = useWorkspaceStore((state) => state.setTabPageId);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const closeArchivedPageTabs = useWorkspaceStore(
    (state) => state.closeArchivedPageTabs,
  );
  const handleArchived = useCallback(
    (archived: ArchivedPage) => {
      closeArchivedPageTabs(archived.page_id, archived.original_path);
      if (routerHistory) replaceFolioHistoryAfterArchive(routerHistory);
      if (mobile) void navigate({ to: "/" });
    },
    [closeArchivedPageTabs, mobile, navigate, routerHistory],
  );
  const focusRequestId = useWorkspaceStore(
    (state) => state.tabs.find((tab) => tab.id === tabId)?.focusRequestId,
  );
  const takeTabFocus = useWorkspaceStore((state) => state.takeTabFocus);
  const pendingHistoryLocationId = useSyncExternalStore(
    subscribeFolioHistoryRestorationRequests,
    () => readFolioHistoryRestorationRequestId(tabId, path),
  );
  useEffect(() => {
    if (editor.pageId) setTabPageId(tabId, editor.pageId);
  }, [editor.pageId, setTabPageId, tabId]);
  const onMobileBack = () => {
    if (!router.history.canGoBack()) {
      leaveFolioWorkspace(() => {
        void navigate({ to: "/" });
      });
      return;
    }

    router.history.back();
  };
  useEffect(() => {
    if (isTodayDraftPath && journalToday?.path && journalToday.path !== path) {
      updateTabPath(
        tabId,
        journalToday.path,
        journalToday.meta.title ?? undefined,
      );
    }
  }, [isTodayDraftPath, journalToday, path, tabId, updateTabPath]);
  useEffect(() => {
    if (
      isTodayAiDraftPath &&
      aiJournalToday?.path &&
      aiJournalToday.path !== path
    ) {
      updateTabPath(
        tabId,
        aiJournalToday.path,
        aiJournalToday.meta.title ?? undefined,
      );
    }
  }, [isTodayAiDraftPath, aiJournalToday, path, tabId, updateTabPath]);

  const assign = useAssignPage();
  const projects = useProjects();
  const setProgress = useSetReadingProgress();
  const encryptionActions = useOptionalEncryptionActions();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const pendingProgressFrame = useRef<number | null>(null);
  const latestProgress = useRef(0);
  const [protectionDialog, setProtectionDialog] = useState<
    "protect" | "unprotect" | null
  >(null);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [organizationOpen, setOrganizationOpen] = useState(false);
  const [conversationMode, setConversationMode] = useState<"read" | "edit">(
    "read",
  );
  const folioEditorRef = useRef<CustomEditor | null>(null);
  const lastMountedFolioEditorRef = useRef<CustomEditor | null>(null);
  const rawMarkdownSessionRef = useRef<RawMarkdownSession | null>(null);
  const restorationStateRef = useRef<{
    tabId: string;
    path: string;
    available: boolean;
    getRevision: () => string;
  } | null>(null);
  const consumedHistoryLocationIdRef = useRef<string | null>(null);

  const buildRestorationSnapshot = useCallback((): FolioRestoration | null => {
    const state = restorationStateRef.current;
    const slateEditor =
      folioEditorRef.current ?? lastMountedFolioEditorRef.current;
    const scrollContainer = bodyRef.current;
    if (
      !state ||
      state.tabId !== tabId ||
      state.path !== path ||
      !state.available ||
      !slateEditor ||
      !scrollContainer
    ) {
      return null;
    }

    const selection = slateEditor.selection;
    return {
      tabId,
      path,
      revision: state.getRevision(),
      scrollTop: scrollContainer.scrollTop,
      anchor: selection
        ? snapshotTextPoint(slateEditor, selection.anchor)
        : null,
      focus: selection ? snapshotTextPoint(slateEditor, selection.focus) : null,
    };
  }, [path, tabId]);

  useLayoutEffect(
    () => registerFolioHistoryCapture(tabId, path, buildRestorationSnapshot),
    [buildRestorationSnapshot, path, tabId],
  );

  // An in-place SlateEditor remount (external content adopt, conflict reload,
  // unlock) destroys the caret. Snapshot selection and focus as the old
  // instance unmounts so the editorRevision-keyed restore effect below can
  // hand them back. bodyRef being empty means the whole folio is unmounting —
  // the folio-level unmount save owns that case (and never records focus, so
  // returning to a tab cannot steal it).
  const handleEditorSwapSnapshot = useCallback(
    (slateEditor: CustomEditor) => {
      const scrollContainer = bodyRef.current;
      if (!scrollContainer) return;
      // Entering raw Markdown mode also unmounts the editor; the raw session
      // owns caret state until it exits, so no snapshot belongs there.
      if (rawMarkdownSessionRef.current) return;
      const state = restorationStateRef.current;
      if (
        !state ||
        state.tabId !== tabId ||
        state.path !== path ||
        !state.available
      ) {
        return;
      }
      const selection = slateEditor.selection;
      saveFolioRestoration({
        tabId,
        path,
        revision: state.getRevision(),
        scrollTop: scrollContainer.scrollTop,
        anchor: selection
          ? snapshotTextPoint(slateEditor, selection.anchor)
          : null,
        focus: selection
          ? snapshotTextPoint(slateEditor, selection.focus)
          : null,
        hadFocus: ReactEditor.isFocused(slateEditor),
      });
    },
    [path, tabId],
  );
  const [recipeMode, setRecipeMode] = useState<"read" | "edit">("read");
  const [recipeProjection, setRecipeProjection] = useState<{
    path: string;
    editorRevision: number;
    result: RecipeParseResult;
  } | null>(null);
  const [rawMarkdownSession, setRawMarkdownSession] =
    useState<RawMarkdownSession | null>(null);
  rawMarkdownSessionRef.current = rawMarkdownSession;
  const modePathRef = useRef(path);
  useEffect(() => {
    if (modePathRef.current === path) return;
    modePathRef.current = path;
    setConversationMode("read");
    setRecipeMode("read");
    setRecipeProjection(null);
  }, [path]);
  useEffect(() => {
    setRawMarkdownSession((current) => {
      if (
        !current ||
        current.path === path ||
        current.value !== current.snapshot
      ) {
        return current;
      }
      return null;
    });
  }, [path]);
  const insertionIdRef = useRef(0);
  const [attachmentInsertion, setAttachmentInsertion] = useState<{
    id: number;
    markdown: string;
  } | null>(null);
  const requestAttachmentInsertion = useCallback((markdown: string) => {
    insertionIdRef.current += 1;
    setAttachmentInsertion({ id: insertionIdRef.current, markdown });
  }, []);
  const finishAttachmentInsertion = useCallback((id: number) => {
    setAttachmentInsertion((current) => (current?.id === id ? null : current));
  }, []);

  // Assigning a kind/project writes frontmatter AND moves the file, so the
  // page path changes. Repoint the open tab to the new path; because FOLIO is
  // keyed on the tab path (TabContent), this remounts the editor at the new
  // location — the entire follow mechanism.
  const followMove = (data: { path?: string }) => {
    if (data.path && data.path !== path) updateTabPath(tabId, data.path);
  };

  useEffect(() => {
    if (editor.title) updateTabLabel(tabId, editor.title);
  }, [tabId, editor.title, updateTabLabel]);

  useEffect(() => {
    setProgress(0);
  }, [setProgress]);

  useEffect(
    () => () => {
      if (pendingProgressFrame.current !== null) {
        cancelAnimationFrame(pendingProgressFrame.current);
      }
    },
    [],
  );

  const folioCode = shortFolio(path);
  const kind = useMemo(
    () => resolveKind({ path, kind: editor.kind, body: editor.bodyMarkdown }),
    [path, editor.kind, editor.bodyMarkdown],
  );
  const isJournalKind = kind === "JOURNAL" || kind === "AI_JOURNAL";
  const presentation = presentationFor(kind);
  const isAiConversation = presentation.bodyPresentation === "ai-conversation";
  const conversationReadOnly = isAiConversation && conversationMode === "read";
  const isRecipe = presentation.bodyPresentation === "recipe";
  const recipeParse = useMemo(
    () =>
      isRecipe ? parseRecipeMarkdown(editor.bodyMarkdown, editor.title) : null,
    [editor.bodyMarkdown, editor.title, isRecipe],
  );
  const activeRecipeParse =
    recipeProjection?.path === path &&
    recipeProjection.editorRevision === editor.editorRevision
      ? recipeProjection.result
      : recipeParse;
  const recipeDocument =
    activeRecipeParse?.ok === true ? activeRecipeParse.value : null;
  const recipeStructured = activeRecipeParse?.ok === true;
  const recipeHasBlockIds =
    isRecipe && containsBlockId(editor.editorValue ?? editor.initialValue);
  const recipePresentationStructured = recipeStructured && !recipeHasBlockIds;
  const recipeReadOnly = recipePresentationStructured && recipeMode === "read";
  // Archived bodies are generated from a captured snapshot, and the page's
  // frontmatter hash claims to describe them; the server refuses body writes
  // until the reader explicitly unlocks the page.
  const offlineReadOnly = editor.offline === true;
  const bodyProtected =
    editor.readonly === true &&
    !offlineReadOnly &&
    !editor.generatedChangePending;
  const folioReadOnly =
    conversationReadOnly || recipeReadOnly || bodyProtected || offlineReadOnly;
  const encrypted = editor.encrypted === true;
  const encryptionState = editor.encryptionState ?? {
    status: "plain" as const,
    body: editor.bodyMarkdown,
  };
  const folioProperties = (
    <FolioProperties
      pageId={editor.pageId ?? ""}
      path={path}
      locked={encrypted && encryptionState.status !== "plain"}
      readOnly={folioReadOnly}
    />
  );
  const rawMarkdownPresentationAvailable =
    presentation.bodyPresentation === "editor" ||
    (isAiConversation && conversationMode === "edit") ||
    (isRecipe &&
      recipeStructured &&
      (recipeHasBlockIds || recipeMode === "edit"));
  const rawMarkdownAvailable =
    rawMarkdownPresentationAvailable &&
    !editor.isLoading &&
    !(editor.error && !editor.isDraft) &&
    !offlineReadOnly &&
    (!encrypted || encryptionState.status === "plain") &&
    !(isTodayDraftPath && (isJournalTodayLoading || journalToday)) &&
    !(isTodayAiDraftPath && (isAiJournalTodayLoading || aiJournalToday));
  const rawMarkdownDirty =
    rawMarkdownSession !== null &&
    rawMarkdownSession.value !== rawMarkdownSession.snapshot;
  const openRawMarkdown = () => {
    if (!rawMarkdownAvailable) return;
    const snapshot = editor.getPlaintext();
    setRawMarkdownSession({
      path,
      entryRevision: editor.getRevision(),
      snapshot,
      value: snapshot,
      diagnostic: null,
    });
  };
  const applyRawMarkdown = () => {
    if (!rawMarkdownSession) return;
    if (!rawMarkdownAvailable) {
      setRawMarkdownSession((current) =>
        current
          ? {
              ...current,
              diagnostic:
                "This Folio is no longer editable. Keep or copy this raw Markdown draft, then return to Edit before applying.",
            }
          : current,
      );
      return;
    }
    if (
      rawMarkdownSession.path !== path ||
      editor.getRevision() !== rawMarkdownSession.entryRevision
    ) {
      setRawMarkdownSession((current) =>
        current
          ? {
              ...current,
              diagnostic:
                "This Folio changed after raw Markdown mode opened. Keep or copy this draft, then reopen raw mode before applying.",
            }
          : current,
      );
      return;
    }
    try {
      const authoredRaw = rawMarkdownSession.value;
      const projectedRecipe = isRecipe
        ? parseRecipeMarkdown(authoredRaw, editor.title)
        : null;
      editor.setBodyMarkdown(authoredRaw);
      if (projectedRecipe) {
        setRecipeProjection({
          path,
          editorRevision: editor.editorRevision,
          result: projectedRecipe,
        });
      }
      setRawMarkdownSession(null);
    } catch (error) {
      setRawMarkdownSession((current) =>
        current
          ? { ...current, diagnostic: rawMarkdownApplyDiagnostic(error) }
          : current,
      );
    }
  };
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
    conversationReadOnly,
    editor.isLoading,
    editor.isEditorSynchronized,
    focusRequestId,
    tabId,
    takeTabFocus,
  ]);

  // ⌘S / Ctrl-S flushes a save from anywhere in the folio (title, tags,
  // rails) — not just the editor body — and suppresses the browser dialog.
  const saveNow = editor.saveNow;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!matchesChord(e, SHORTCUTS["folio.save"].chord)) return;
      e.preventDefault();
      if (folioReadOnly) return;
      void saveNow().catch(() => undefined);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [folioReadOnly, saveNow]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    latestProgress.current = max > 0 ? Math.min(1, el.scrollTop / max) : 0;
    if (pendingProgressFrame.current !== null) return;
    pendingProgressFrame.current = requestAnimationFrame(() => {
      pendingProgressFrame.current = null;
      setProgress(latestProgress.current);
    });
  };

  const restorationAvailable =
    !editor.isLoading &&
    !(editor.error && !editor.isDraft) &&
    (!encrypted || encryptionState.status === "plain");
  restorationStateRef.current = {
    tabId,
    path,
    available: restorationAvailable,
    getRevision: editor.getRevision,
  };

  useEffect(() => {
    // A revision change can swap the mounted Slate editor without changing this effect's direct inputs.
    void editor.editorRevision;
    if (folioEditorRef.current) {
      lastMountedFolioEditorRef.current = folioEditorRef.current;
    }
  }, [editor.editorRevision]);

  useEffect(() => {
    if (!editor.isLoading && !restorationAvailable) {
      clearFolioRestoration(tabId);
    }
  }, [editor.isLoading, restorationAvailable, tabId]);

  useLayoutEffect(
    () => () => {
      const currentTab = useWorkspaceStore
        .getState()
        .tabs.find((tab) => tab.id === tabId);
      if (currentTab?.path !== path) {
        clearFolioRestoration(tabId);
        return;
      }

      const restoration = buildRestorationSnapshot();
      if (!restoration) {
        clearFolioRestoration(tabId);
        return;
      }
      saveFolioRestoration(restoration);
    },
    [buildRestorationSnapshot, path, tabId],
  );

  useLayoutEffect(() => {
    // A revision change remounts the keyed Slate editor and must retry any captured restoration.
    void editor.editorRevision;
    if (
      pendingHistoryLocationId === null &&
      consumedHistoryLocationIdRef.current !== null
    ) {
      consumedHistoryLocationIdRef.current = null;
      return;
    }
    const historyRequest = readFolioHistoryRestorationRequest(tabId, path);
    if (!restorationAvailable) {
      if (!editor.isLoading && editor.pageNotFound && historyRequest) {
        consumeFolioHistoryRestorationRequest(
          historyRequest.request.locationId,
        );
      }
      return;
    }

    const restoration = historyRequest
      ? historyRequest.restoration
      : readFolioRestoration(tabId, path);
    if (!historyRequest && !restoration) return;

    const frame = requestAnimationFrame(() => {
      const state = restorationStateRef.current;
      if (
        !state ||
        state.tabId !== tabId ||
        state.path !== path ||
        !state.available
      ) {
        if (
          historyRequest &&
          state &&
          (state.tabId !== tabId || state.path !== path)
        ) {
          consumeFolioHistoryRestorationRequest(
            historyRequest.request.locationId,
          );
        }
        return;
      }

      const slateEditor = folioEditorRef.current;
      const scrollContainer = bodyRef.current;
      if (!slateEditor || !scrollContainer) return;

      if (restoration) {
        const requireTextMatch = restoration.revision !== editor.getRevision();
        let selection: Range | null = null;
        if (restoration.anchor && restoration.focus) {
          const anchor = validateTextPointSnapshot(
            slateEditor,
            restoration.anchor,
            requireTextMatch,
          );
          const focus = validateTextPointSnapshot(
            slateEditor,
            restoration.focus,
            requireTextMatch,
          );
          if (anchor && focus) selection = { anchor, focus };
        }

        scrollContainer.scrollTop = restoration.scrollTop;
        if (selection) Transforms.select(slateEditor, selection);
        if (restoration.hadFocus) {
          // The user was typing in the swapped-out instance; hand the caret
          // back. When the saved points no longer fit the adopted content,
          // fall back to the end of the document rather than dropping focus.
          if (!selection) {
            Transforms.select(slateEditor, Editor.end(slateEditor, []));
          }
          ReactEditor.focus(slateEditor);
        }
      }

      if (historyRequest) {
        consumedHistoryLocationIdRef.current =
          historyRequest.request.locationId;
        consumeFolioHistoryRestorationRequest(
          historyRequest.request.locationId,
        );
      }
    });

    return () => {
      cancelAnimationFrame(frame);
      const state = restorationStateRef.current;
      if (
        historyRequest &&
        state &&
        (state.tabId !== tabId || state.path !== path)
      ) {
        consumeFolioHistoryRestorationRequest(
          historyRequest.request.locationId,
        );
      }
    };
  }, [
    editor.editorRevision,
    editor.getRevision,
    editor.isLoading,
    pendingHistoryLocationId,
    editor.pageNotFound,
    path,
    restorationAvailable,
    tabId,
  ]);
  const computedTags = useMemo(
    () => [...new Set(editor.computedTags)],
    [editor.computedTags],
  );
  const computedTagSet = useMemo(() => new Set(computedTags), [computedTags]);
  const editableTags = useMemo(
    () => editor.tags.filter((tag) => !computedTagSet.has(tag)),
    [computedTagSet, editor.tags],
  );
  const effectiveTags = useMemo(
    () => [...editableTags, ...computedTags],
    [computedTags, editableTags],
  );
  const archiveTagEditor: ArchiveTagEditorProps | undefined =
    bodyProtected && editor.archive
      ? {
          values: editableTags,
          computedValues: computedTags,
          suggestions: tagSuggestions,
          onSuggestionQueryChange: setTagSuggestionQuery,
          suggestionsLoading: tagSuggestionsLoading,
          suggestionsError: tagSuggestionsError,
          onRetrySuggestions: tagSuggestionRequest.refetch,
          onChange: editor.setTags,
          onBlur: () => {
            void Promise.resolve(editor.saveNow()).catch(() => undefined);
          },
        }
      : undefined;
  const inferred = editor.inferred;
  const project = editor.project;

  const currentEditorValue = editor.editorValue ?? editor.initialValue;
  const visibleEditorValue =
    encrypted && encryptionState.status !== "plain"
      ? EMPTY_EDITOR_VALUE
      : currentEditorValue;
  const wordCount = useMemo(
    () => countWordsFromSlate(visibleEditorValue),
    [visibleEditorValue],
  );
  const isActiveTab = useWorkspaceStore((s) => s.activeTabId === tabId);
  useFooterContext(
    isActiveTab
      ? [
          path,
          ...(wordCount > 0 ? [`${wordCount.toLocaleString()} words`] : []),
        ]
      : null,
  );
  const toc = useMemo(() => buildToc(visibleEditorValue), [visibleEditorValue]);
  const conversationDiagnostics = useMemo(
    () =>
      isAiConversation
        ? diagnoseConversationMarkdown(editor.bodyMarkdown)
        : null,
    [editor.bodyMarkdown, isAiConversation],
  );
  const addConversationTurn = useCallback(() => {
    if (!folioEditorRef.current) return;
    insertConversationTurn(folioEditorRef.current);
  }, []);
  const { activeIndex, scrollTo } = useScrollSpy(
    bodyRef,
    editor.editorRevision,
    mobile,
  );
  const pageActions = editor.isDraft ? null : (
    <Suspense
      fallback={
        <p className="mb-0 text-[13px] text-mute">Loading page actions…</p>
      }
    >
      <PageActionsMenu
        path={path}
        beforeMutation={editor.saveNow}
        onMoved={(nextPath) => updateTabPath(tabId, nextPath)}
        onArchived={handleArchived}
        archiveOnly={
          folioReadOnly || (encrypted && encryptionState.status !== "plain")
        }
      />
    </Suspense>
  );

  if (
    !rawMarkdownSession &&
    ((isTodayDraftPath && (isJournalTodayLoading || journalToday)) ||
      (isTodayAiDraftPath && (isAiJournalTodayLoading || aiJournalToday)))
  ) {
    return (
      <div className="p-10 text-[13.5px] text-mute">
        Fetching today’s journal…
      </div>
    );
  }
  if (!rawMarkdownSession && editor.isLoading) {
    return <div className="p-10 text-[13.5px] text-mute">Fetching {path}…</div>;
  }
  if (!rawMarkdownSession && editor.error && !editor.isDraft) {
    // Only a settled 404 means the file is actually gone; any other query
    // error is a load failure the user can retry without losing the tab.
    if (editor.pageNotFound) {
      return <FolioNotFound path={path} onClose={() => closeTab(tabId)} />;
    }
    // The service worker's offline_uncached 503: the page was never synced
    // to this device, so retrying while still offline can't succeed either.
    // Same panel RouteError shows for a route-level throw of the same shape.
    if (isOfflineUncached(editor.error)) {
      return <OfflineUnavailable onRetry={resetErroredQueries} />;
    }
    return (
      <FolioError
        path={path}
        error={toError(editor.error)}
        onRetry={resetErroredQueries}
        onClose={() => closeTab(tabId)}
      />
    );
  }
  if (!rawMarkdownSession && encrypted && encryptionState.status !== "plain") {
    return (
      <LockedFolio
        path={path}
        title={editor.title}
        tags={editableTags}
        derivedTags={computedTags}
        state={encryptionState}
        properties={folioProperties}
        pageActions={pageActions}
      />
    );
  }

  const dossierHeader = (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span
          data-testid="folio-meta"
          className="inline-flex items-center gap-1 text-[13px] text-mute"
        >
          <span>{kindDisplayLabel(kind)}</span>
          <span aria-hidden className="text-faint">
            {" · "}
          </span>
          <span>
            {editor.updatedAt
              ? `edited ${formatRelativeTime(editor.updatedAt)}`
              : "not saved yet"}
          </span>
        </span>
        <div className="flex items-center gap-3">
          {folioReadOnly && !archiveTagEditor && editor.revisionConflict ? (
            <span className="text-xs text-destructive">
              Page changed on disk
            </span>
          ) : (
            <SaveIndicator
              status={editor.saveStatus}
              error={editor.saveError}
              revisionConflict={editor.revisionConflict}
              onReloadAfterConflict={editor.reloadAfterConflict}
            />
          )}
        </div>
      </div>
    </>
  );

  // Kind-specific facts (a meeting's occurred/attendees) belong beside the
  // title, not in the META rail: they are content, not sidebar metadata.
  const HeaderExtras = presentation.headerExtras;
  const headerExtras = HeaderExtras ? (
    <HeaderExtras
      path={path}
      tabId={tabId}
      isDraft={editor.isDraft}
      tags={editableTags}
      onTagsChange={editor.setTags}
    />
  ) : null;

  const document = (
    <>
      {folioReadOnly ? (
        <ReadOnlyPageHeader
          path={path}
          title={editor.title}
          tags={effectiveTags}
          aliases={editor.aliases}
          encrypted={encrypted}
          archive={bodyProtected ? editor.archive : null}
          archiveTagEditor={archiveTagEditor}
          onOpenRawMarkdown={
            rawMarkdownAvailable && !rawMarkdownSession
              ? openRawMarkdown
              : undefined
          }
        />
      ) : (
        <div className="mt-4">
          <PageEditorHeader
            path={path}
            title={editor.title}
            onTitleChange={editor.setTitle}
            readOnlyTitle={presentation.readOnlyTitle?.(path, editor.title)}
            tags={editableTags}
            derivedTags={computedTags}
            tagSuggestions={tagSuggestions}
            onTagSuggestionQueryChange={setTagSuggestionQuery}
            tagSuggestionsLoading={tagSuggestionsLoading}
            tagSuggestionsError={tagSuggestionsError}
            onRetryTagSuggestions={tagSuggestionRequest.refetch}
            onTagsChange={editor.setTags}
            aliases={editor.aliases}
            onAliasesChange={editor.setAliases}
            onSaveNow={editor.saveNow}
            encrypted={encrypted}
            onRequestLock={
              rawMarkdownSession ? undefined : encryptionActions?.lock
            }
            onOpenRawMarkdown={
              rawMarkdownAvailable && !rawMarkdownSession
                ? openRawMarkdown
                : undefined
            }
          />
        </div>
      )}
      {headerExtras}
      {folioProperties}
      {isAiConversation ? (
        <>
          {rawMarkdownSession ? null : (
            <AiConversationControls
              mode={conversationMode}
              onModeChange={setConversationMode}
              onAddTurn={addConversationTurn}
            />
          )}
          {conversationDiagnostics &&
          (conversationDiagnostics.malformedMarkerLines.length > 0 ||
            conversationDiagnostics.validMarkers === 0) ? (
            <div className="ai-conversation-warning" role="alert">
              <span>
                {conversationDiagnostics.malformedMarkerLines.length > 0
                  ? `Conversation marker${
                      conversationDiagnostics.malformedMarkerLines.length === 1
                        ? ""
                        : "s"
                    } on line${
                      conversationDiagnostics.malformedMarkerLines.length === 1
                        ? ""
                        : "s"
                    } ${conversationDiagnostics.malformedMarkerLines.join(
                      ", ",
                    )} could not be read. The original text is preserved.`
                  : "This AI conversation has no valid conversation markers. The original Markdown is preserved."}
              </span>
              <button type="button" onClick={() => setConversationMode("edit")}>
                Edit
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {isRecipe && !recipeStructured ? (
        <div className="ai-conversation-warning" role="alert">
          The recipe structure could not be read. The original Markdown is
          preserved in the editor below. To restore structured editing, include
          Ingredients, Steps, and Notes once and in that order as headings of
          one consistent level, with bullet ingredients and numbered steps.
          Components may be grouped under headings one level deeper.
        </div>
      ) : null}

      {rawMarkdownSession ? (
        <RawMarkdownEditor
          value={rawMarkdownSession.value}
          diagnostic={rawMarkdownSession.diagnostic}
          onChange={(value) =>
            setRawMarkdownSession((current) =>
              current ? { ...current, value, diagnostic: null } : current,
            )
          }
          onApply={applyRawMarkdown}
          onCancel={() => setRawMarkdownSession(null)}
        />
      ) : (
        <article
          className={cn(
            "codex-prose mt-9 font-sans text-[17px] leading-[1.7] text-ink-2",
            isAiConversation && `ai-conversation--${conversationMode}`,
          )}
        >
          {offlineReadOnly ? (
            <OfflineBodyNotice />
          ) : bodyProtected ? (
            <ProtectedBodyNotice onUnlock={() => editor.setReadonly(false)} />
          ) : null}
          <WikilinkResolutionProvider path={path}>
            {recipePresentationStructured && recipeDocument ? (
              <RecipeFolioBody
                document={recipeDocument}
                mode={recipeMode}
                onModeChange={setRecipeMode}
                onDocumentChange={(nextDocument) => {
                  setRecipeProjection({
                    path,
                    editorRevision: editor.editorRevision,
                    result: {
                      ok: true,
                      sourceFormat: "markdown",
                      value: nextDocument,
                    },
                  });
                  editor.setBodyMarkdown(serializeRecipeMarkdown(nextDocument));
                }}
              />
            ) : (
              <ConversationPresentationProvider
                value={{
                  mode: isAiConversation ? conversationMode : "generic",
                  provider: isAiConversation
                    ? editor.conversationProvider
                    : null,
                }}
              >
                <BaseRenderingProvider
                  value={{
                    pagePath: path,
                    readonly: folioReadOnly || editor.encrypted,
                    beginGeneratedChange: editor.beginGeneratedChange,
                  }}
                >
                  <SlateEditor
                    key={`${path}:${editor.editorRevision}`}
                    initialValue={currentEditorValue}
                    onChange={editor.onSlateChange}
                    onSaveNow={editor.saveNow}
                    insertionRequest={attachmentInsertion}
                    onInsertionHandled={finishAttachmentInsertion}
                    readOnly={
                      conversationReadOnly ||
                      bodyProtected ||
                      offlineReadOnly ||
                      editor.generatedChangePending
                    }
                    journalDate={
                      journalDateFromPath(path) ?? aiJournalDateFromPath(path)
                    }
                    editorRef={folioEditorRef}
                    onUnmountSnapshot={handleEditorSwapSnapshot}
                  />
                </BaseRenderingProvider>
              </ConversationPresentationProvider>
            )}
          </WikilinkResolutionProvider>
        </article>
      )}
    </>
  );

  const details = (
    <Section compact label="Properties">
      <dl className="m-0 grid grid-cols-[64px_minmax(0,1fr)] gap-x-3.5 gap-y-3 text-[13.5px] leading-[1.4]">
        <Prop k="Kind">
          {folioReadOnly ? (
            <span>{kindLabel(kind)}</span>
          ) : (
            <KindSelect
              value={kind}
              inferred={inferred}
              immutableReason={
                kind === "JOURNAL"
                  ? "Journal kind cannot be changed."
                  : kind === "AI_JOURNAL"
                    ? "AI journal kind cannot be changed."
                    : undefined
              }
              onAssign={(k) =>
                assign.mutate(
                  { params: { path: { path } }, body: { kind: k } },
                  { onSuccess: followMove },
                )
              }
            />
          )}
        </Prop>
        <Prop k="Project">
          {folioReadOnly || isJournalKind ? (
            <span
              title={
                isJournalKind
                  ? "Journal pages cannot join a project."
                  : undefined
              }
            >
              {project ?? "—"}
            </span>
          ) : (
            <ProjectCombo
              key={project ?? ""}
              value={project}
              options={projects}
              onAssign={(slug) =>
                assign.mutate(
                  { params: { path: { path } }, body: { project: slug } },
                  { onSuccess: followMove },
                )
              }
              onClear={() =>
                assign.mutate(
                  {
                    params: { path: { path } },
                    body: { clear_project: true },
                  },
                  { onSuccess: followMove },
                )
              }
            />
          )}
        </Prop>
        <Prop k="ID">{folioCode}</Prop>
        <Prop k="Path">
          <span className="break-all text-mute">{path}</span>
        </Prop>
        <Prop k="Protection">
          {folioReadOnly ? (
            <span>{encrypted ? "Encrypted" : "Plaintext"}</span>
          ) : (
            <button
              type="button"
              className={cn(
                "cursor-pointer rounded text-accent hover:underline disabled:cursor-default disabled:text-mute",
                FOCUS_RING_NATIVE,
              )}
              disabled={!editor.pageId}
              onClick={() =>
                setProtectionDialog(encrypted ? "unprotect" : "protect")
              }
            >
              {encrypted ? "Encrypted · remove" : "Plaintext · protect"}
            </button>
          )}
        </Prop>
        <Prop k="Created">{formatAbsoluteDate(editor.createdAt)}</Prop>
        <Prop k="Modified">{formatRelativeTime(editor.updatedAt)}</Prop>
        <Prop k="Words">{wordCount > 0 ? wordCount : "—"}</Prop>
        <Prop k="Tags">
          <span className="text-ink-2">
            {effectiveTags.length > 0 ? effectiveTags.join(" · ") : "—"}
          </span>
        </Prop>
      </dl>
    </Section>
  );

  const supplementalDetails = (
    <>
      {(() => {
        const Extras = presentation.metaExtras;
        return Extras ? (
          <Section compact label={presentation.metaExtrasLabel ?? "Details"}>
            <Extras
              path={path}
              tabId={tabId}
              isDraft={editor.isDraft}
              tags={editableTags}
              onTagsChange={editor.setTags}
            />
          </Section>
        ) : null;
      })()}

      <Section compact pip="dim" label="Attachments">
        {folioReadOnly ? (
          <p className="m-0 text-[13px] text-mute">
            Switch to Edit to manage attachments.
          </p>
        ) : (
          <>
            <button
              type="button"
              aria-expanded={attachmentsOpen}
              className={cn(
                "flex w-full cursor-pointer items-center justify-between rounded text-[13.5px] text-mute transition-colors hover:text-ink",
                FOCUS_RING_NATIVE,
              )}
              onClick={() => setAttachmentsOpen((open) => !open)}
            >
              <span>Manage attachments</span>
              <span aria-hidden>{attachmentsOpen ? "⌄" : "›"}</span>
            </button>
            {attachmentsOpen ? (
              <Suspense
                fallback={
                  <p className="mt-2 mb-0 text-[13px] text-mute">
                    Loading attachment tools…
                  </p>
                }
              >
                <div className="mt-2">
                  <AttachmentManager
                    protectedPage={encrypted}
                    pageMarkdown={editor.bodyMarkdown}
                    onInsertMarkdown={requestAttachmentInsertion}
                  />
                </div>
              </Suspense>
            ) : null}
          </>
        )}
      </Section>

      <Section compact pip="dim" label="Organization">
        {editor.isDraft ? (
          <p className="m-0 text-[13px] text-mute">
            Save this page before moving or archiving it.
          </p>
        ) : folioReadOnly ? (
          <div className="grid gap-2">
            <p className="m-0 text-[13px] text-mute">
              Switch to Edit to move this page. Archiving remains available.
            </p>
            {pageActions}
          </div>
        ) : (
          <>
            <button
              type="button"
              aria-expanded={organizationOpen}
              className={cn(
                "flex w-full cursor-pointer items-center justify-between rounded text-[13.5px] text-mute transition-colors hover:text-ink",
                FOCUS_RING_NATIVE,
              )}
              onClick={() => setOrganizationOpen((open) => !open)}
            >
              <span>Manage paths</span>
              <span aria-hidden>{organizationOpen ? "⌄" : "›"}</span>
            </button>
            {organizationOpen ? (
              <Suspense
                fallback={
                  <p className="mt-2 mb-0 text-[13px] text-mute">
                    Loading path tools…
                  </p>
                }
              >
                <div className="mt-2 grid gap-2">
                  {pageActions}
                  <FolderActionsMenu
                    beforeMutation={editor.saveNow}
                    onMoved={(source, destination) => {
                      if (path === source || path.startsWith(`${source}/`)) {
                        updateTabPath(
                          tabId,
                          `${destination}${path.slice(source.length)}`,
                        );
                      }
                    }}
                    onDeleted={(source) => {
                      if (path === source || path.startsWith(`${source}/`)) {
                        runWorkspaceTransition(() => {
                          closeTab(tabId);
                          if (mobile) void navigate({ to: "/" });
                        });
                      }
                    }}
                  />
                </div>
              </Suspense>
            ) : null}
          </>
        )}
      </Section>
    </>
  );

  const contents = (
    <Section compact label="On this page">
      {toc.length === 0 ? (
        <p className="m-0 text-[13px] text-mute">No headings yet.</p>
      ) : (
        <nav aria-label="On this page" className="flex flex-col gap-2.5">
          {toc.map((h, i) => {
            const active = i === activeIndex;
            return (
              <button
                key={h.number}
                type="button"
                onClick={() => scrollTo(i)}
                aria-current={active ? "location" : undefined}
                className={cn(
                  "cursor-pointer truncate rounded text-left text-[14px] transition-colors",
                  active ? "text-ink" : "text-mute hover:text-ink",
                  FOCUS_RING_NATIVE,
                )}
                style={{ paddingLeft: (h.depth - 1) * 14 }}
              >
                {h.text}
              </button>
            );
          })}
        </nav>
      )}
    </Section>
  );

  const similarItems = similar?.items ?? [];
  // The index returns one row per link; the rail shows one card per source.
  const linkedFrom = (backlinks ?? []).filter(
    (b, i, all) => all.findIndex((o) => o.source_path === b.source_path) === i,
  );
  const relationships = (
    <>
      <Section compact label="Linked from" caption={String(linkedFrom.length)}>
        {linkedFrom.length === 0 ? (
          <p className="m-0 text-[13px] text-mute">No pages link here yet.</p>
        ) : (
          <div className="flex flex-col gap-6">
            {linkedFrom.map((b) => (
              <CLink
                key={b.source_path}
                path={b.source_path}
                className={cn(
                  "cl-link-plain flex flex-col gap-1.5 rounded",
                  FOCUS_RING_NATIVE,
                )}
              >
                <span
                  data-link-title
                  className="font-serif text-[21px] leading-[1.2] text-ink"
                >
                  {b.source_title || b.source_path}
                </span>
                {b.context ? (
                  <span
                    data-link-snippet
                    className="text-[13.5px] leading-[1.55] text-mute"
                  >
                    {highlightMatch(plainWikiText(b.context), [
                      ...b.target_raw.split("|"),
                      editor.title ?? "",
                    ])}
                  </span>
                ) : null}
              </CLink>
            ))}
          </div>
        )}
      </Section>

      <Section
        compact
        pip="dim"
        label="Links out"
        caption={String(visibleOutlinks.length)}
      >
        <LinkList
          empty="No outbound links yet."
          items={visibleOutlinks.map((o) => ({
            path: o.target_path,
            title: o.target_raw || o.target_path,
          }))}
        />
      </Section>

      {similarItems.length > 0 ? (
        <Section compact pip="dim" label="Similar">
          <LinkList
            empty=""
            items={similarItems.map((s) => ({
              path: s.path,
              title: s.title || s.path,
            }))}
          />
        </Section>
      ) : null}
    </>
  );

  const protection =
    !folioReadOnly && protectionDialog && editor.pageId ? (
      <Suspense fallback={null}>
        <NoteProtectionDialog
          mode={protectionDialog}
          page={{
            id: editor.pageId,
            path,
            title: editor.title,
            tags: editor.tags ?? [],
          }}
          saveNow={editor.saveNow}
          getPlaintext={editor.getPlaintext}
          getRevision={editor.getRevision}
          onComplete={() => setProtectionDialog(null)}
          onDismiss={() => setProtectionDialog(null)}
        />
      </Suspense>
    ) : null;
  const overlays = (
    <>
      {protection}
      {rawMarkdownSession ? (
        <RawMarkdownNavigationGuard
          dirty={rawMarkdownDirty}
          onLeave={() => setRawMarkdownSession(null)}
        />
      ) : null}
    </>
  );

  if (mobile) {
    return (
      <>
        <MobileFolioLayout
          header={dossierHeader}
          document={
            <div
              ref={bodyRef}
              onScroll={onScroll}
              className="cl-noscroll h-full overflow-y-auto px-4 pt-1 pb-10"
            >
              {document}
            </div>
          }
          details={
            <>
              {details}
              {supplementalDetails}
            </>
          }
          relationships={relationships}
          contents={contents}
          onBack={onMobileBack}
        />
        {overlays}
      </>
    );
  }

  return (
    <DesktopFolioLayout
      header={dossierHeader}
      document={document}
      details={details}
      supplementalDetails={supplementalDetails}
      relationships={relationships}
      contents={contents}
      bodyRef={bodyRef}
      onScroll={onScroll}
      toc={toc}
      activeIndex={activeIndex}
      onJump={scrollTo}
      protection={overlays}
    />
  );
}

function DesktopFolioLayout({
  header,
  document,
  details,
  relationships,
  supplementalDetails,
  contents,
  bodyRef,
  onScroll,
  toc,
  activeIndex,
  onJump,
  protection,
}: {
  header: React.ReactNode;
  document: React.ReactNode;
  details: React.ReactNode;
  relationships: React.ReactNode;
  contents: React.ReactNode;
  supplementalDetails: React.ReactNode;
  bodyRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  toc: TocEntry[];
  activeIndex: number;
  onJump: (index: number) => void;
  protection: React.ReactNode;
}) {
  const left = useCollapsibleRail({
    storageKey: FOLIO_LEFT_RAIL,
    side: "left",
    defaultWidth: 232,
    min: 180,
    max: 480,
  });
  const right = useCollapsibleRail({
    storageKey: FOLIO_RIGHT_RAIL,
    side: "right",
    defaultWidth: 296,
    min: 220,
    max: 480,
  });
  const column = useReadingColumn();
  const lw = left.collapsed ? 32 : left.width;
  const rw = right.collapsed ? 32 : right.width;

  return (
    <div
      className="grid h-full min-h-0 gap-8 px-6 xl:gap-16 xl:px-10"
      style={{ gridTemplateColumns: `${lw}px 1fr ${rw}px` }}
    >
      {left.collapsed ? (
        <RailStub side="left" onExpand={left.toggle} />
      ) : (
        <aside
          aria-label="Page details"
          className="cl-noscroll relative flex min-w-0 flex-col gap-12 overflow-auto pt-16 pb-10"
        >
          <RailHideButton side="left" onCollapse={left.toggle} />
          {contents}
          {details}
          {supplementalDetails}
          <Resizer onPointerDown={left.onResizeStart} side="right" />
        </aside>
      )}

      <div
        className="relative min-h-0"
        ref={column.paneRef}
        // Published for the content: an embed may exceed the reading column,
        // but the pane is the hard bound.
        style={
          column.available > 0
            ? ({
                "--folio-pane-w": `${Math.round(column.available)}px`,
              } as CSSProperties)
            : undefined
        }
      >
        <div
          ref={bodyRef}
          onScroll={onScroll}
          className="cl-noscroll h-full overflow-auto"
        >
          <div
            className="mx-auto px-7 pt-16 pb-16"
            style={{ maxWidth: `${column.width}px` }}
          >
            {header}
            {document}
          </div>
        </div>
        {/* Anchored to the column's right edge, which sits half its width from
            the centre of the pane. */}
        <div
          className="pointer-events-none absolute inset-y-0 left-1/2 z-10"
          style={{ transform: `translateX(${column.width / 2}px)` }}
        >
          <div className="pointer-events-auto relative h-full">
            <ReadingColumnResizer
              width={column.width}
              onWidth={column.setWidth}
              onReset={column.reset}
              onDragStart={column.onDragStart}
            />
          </div>
        </div>
        <ReadingTicks toc={toc} activeIndex={activeIndex} onJump={onJump} />
      </div>

      {right.collapsed ? (
        <RailStub side="right" onExpand={right.toggle} />
      ) : (
        <aside
          aria-label="Page links"
          className="cl-noscroll relative flex min-w-0 flex-col gap-7 overflow-auto pt-16 pb-10"
        >
          <Resizer onPointerDown={right.onResizeStart} side="left" />
          <RailHideButton side="right" onCollapse={right.toggle} />
          {relationships}
        </aside>
      )}
      {protection}
    </div>
  );
}

type ArchiveTagEditorProps = {
  values: string[];
  computedValues: string[];
  suggestions: string[];
  onSuggestionQueryChange: (query: string) => void;
  suggestionsLoading: boolean;
  suggestionsError: Error | null;
  onRetrySuggestions: () => void;
  onChange: (tags: string[]) => void;
  onBlur: () => void;
};

function ReadOnlyPageHeader({
  path,
  title,
  tags,
  aliases,
  archive,
  archiveTagEditor,
  encrypted,
  onOpenRawMarkdown,
}: {
  path: string;
  title: string;
  tags: string[];
  aliases: string[];
  archive: NonNullable<PageMeta["archive"]> | null;
  archiveTagEditor?: ArchiveTagEditorProps;
  encrypted: boolean;
  onOpenRawMarkdown?: () => void;
}) {
  const displayTitle = title || path.split("/").pop() || path;
  return (
    <section
      aria-label="Page metadata"
      className="mt-4 pb-4 max-md:flex max-md:flex-col max-md:gap-3"
    >
      {encrypted ? (
        <span className="mb-2 block text-[13px] text-mute">Encrypted</span>
      ) : null}
      <div className="flex items-start gap-2">
        <h1 className="min-w-0 w-full flex-1 font-serif text-[clamp(44px,4.2vw,60px)] font-normal leading-[1.02] tracking-[-0.015em] text-ink">
          {displayTitle}
        </h1>
        {onOpenRawMarkdown ? (
          <div className="flex shrink-0 items-center gap-1 pt-3 max-md:pt-0">
            <RawMarkdownButton onPress={onOpenRawMarkdown} />
          </div>
        ) : null}
      </div>
      {archive?.snapshot_hash ? (
        <Link
          to="/archive/$"
          params={{ _splat: path }}
          className={cn(
            "mt-3 inline-block rounded text-[13.5px] text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent",
            FOCUS_RING_NATIVE,
          )}
        >
          View archived snapshot
        </Link>
      ) : null}
      {archiveTagEditor ? (
        <TagInput
          label="Tags"
          ariaLabel="Archive tags"
          values={archiveTagEditor.values}
          readOnlyValues={archiveTagEditor.computedValues}
          suggestions={archiveTagEditor.suggestions}
          onSuggestionQueryChange={archiveTagEditor.onSuggestionQueryChange}
          suggestionsLoading={archiveTagEditor.suggestionsLoading}
          suggestionsError={archiveTagEditor.suggestionsError}
          onRetrySuggestions={archiveTagEditor.onRetrySuggestions}
          onChange={archiveTagEditor.onChange}
          onBlur={archiveTagEditor.onBlur}
          placeholder="Add tag..."
        />
      ) : null}
      {!archiveTagEditor || aliases.length > 0 ? (
        <dl className="mt-3 grid gap-2 text-[13px]">
          {!archiveTagEditor ? (
            <div className="flex flex-wrap items-baseline gap-2">
              <dt className="text-mute">Tags</dt>
              <dd className="m-0 flex flex-wrap gap-1.5 text-ink-2">
                {tags.length > 0
                  ? tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-sink px-2.5 leading-6"
                      >
                        {tag}
                      </span>
                    ))
                  : "—"}
              </dd>
            </div>
          ) : null}
          {aliases.length > 0 ? (
            <div className="flex flex-wrap items-baseline gap-2">
              <dt className="text-mute">Aliases</dt>
              <dd className="m-0 flex flex-wrap gap-1.5 text-ink-2">
                {aliases.map((alias) => (
                  <span
                    key={alias}
                    className="rounded-full bg-sink px-2.5 leading-6"
                  >
                    {alias}
                  </span>
                ))}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </section>
  );
}

/* ── small presentational helpers ─────────────────────────────────────── */

/**
 * Reading-position rail: one horizontal tick per heading, stacked vertically in
 * the prose gutter, with the active section's tick widened + accented. Replaces
 * the old horizontal scroll-fraction bar. Ticks step in from the right edge by
 * heading depth, echoing the left-rail TOC's indentation.
 */
function ReadingTicks({
  toc,
  activeIndex,
  onJump,
}: {
  toc: TocEntry[];
  activeIndex: number;
  onJump: (index: number) => void;
}) {
  if (toc.length === 0) return null;
  return (
    <nav
      aria-label="Reading position"
      className="pointer-events-none absolute top-1/2 right-3 z-10 flex max-h-[88%] -translate-y-1/2 flex-col items-end gap-1 overflow-hidden"
    >
      {toc.map((h, i) => {
        const active = i === activeIndex;
        return (
          <button
            key={h.number}
            type="button"
            onClick={() => onJump(i)}
            aria-label={`${h.number} ${h.text}`}
            aria-current={active ? "location" : undefined}
            title={h.text}
            style={{ marginRight: (h.depth - 1) * 4 }}
            className="group pointer-events-auto flex flex-shrink-0 cursor-pointer items-center justify-end py-[5px] pl-5"
          >
            <span
              className={cn(
                "h-[3px] rounded-full transition-all",
                active
                  ? "w-7 bg-accent"
                  : "w-3.5 bg-faint group-hover:w-5 group-hover:bg-ink",
              )}
            />
          </button>
        );
      })}
    </nav>
  );
}

function OfflineBodyNotice() {
  return (
    <div
      role="status"
      className="mb-6 flex items-center gap-3 rounded-xl bg-sink px-4 py-3 text-[13.5px] text-ink-2"
    >
      <span>
        Offline — read only. Edits resume when the connection returns.
      </span>
    </div>
  );
}

function ProtectedBodyNotice({ onUnlock }: { onUnlock: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div
      role="status"
      className="mb-6 flex items-center justify-between gap-3 rounded-xl bg-sink px-4 py-3 text-[13.5px] text-ink-2"
    >
      <span>
        This page is a captured archive. Its body is kept as captured so the
        recorded content hash stays true.
      </span>
      <Button
        variant="secondary"
        size="sm"
        className="shrink-0"
        isDisabled={busy}
        onPress={async () => {
          setBusy(true);
          try {
            onUnlock();
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Unlocking\u2026" : "Edit anyway"}
      </Button>
    </div>
  );
}

const RAIL_CHORD = {
  left: SHORTCUTS["folio.toggleLeft"].chord,
  right: SHORTCUTS["folio.toggleRight"].chord,
} as const;

/** The rail's hide control: a 32px round ghost button level with the first
 *  section's eyebrow (mockup), so no header band is needed. */
function RailHideButton({
  side,
  onCollapse,
}: {
  side: "left" | "right";
  onCollapse: () => void;
}) {
  return (
    <IconButton
      aria-label={`Hide ${side} sidebar`}
      onPress={onCollapse}
      className="absolute top-[58px] right-0 z-10 text-faint"
    >
      <span aria-hidden title={`Hide sidebar ${formatChord(RAIL_CHORD[side])}`}>
        {side === "left" ? <PanelLeftClose /> : <PanelRightClose />}
      </span>
    </IconButton>
  );
}

/** A collapsed rail: one 32px round `sink` button that shows it again. */
function RailStub({
  side,
  onExpand,
}: {
  side: "left" | "right";
  onExpand: () => void;
}) {
  return (
    <div className={cn("flex pt-16", side === "right" && "justify-end")}>
      <button
        type="button"
        onClick={onExpand}
        aria-label={`Show ${side} sidebar`}
        title={`Show sidebar ${formatChord(RAIL_CHORD[side])}`}
        className={cn(
          "flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-sink text-mute transition-colors hover:text-ink [&_svg]:h-4 [&_svg]:w-4",
          FOCUS_RING_NATIVE,
        )}
      >
        {side === "left" ? <PanelLeftOpen /> : <PanelRightOpen />}
      </button>
    </div>
  );
}

function Resizer({
  onPointerDown,
  side,
}: {
  onPointerDown: (e: React.PointerEvent) => void;
  side: "left" | "right";
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      className={cn(
        "absolute top-0 z-20 h-full w-[3px] cursor-col-resize rounded-full hover:bg-accent",
        side === "left" ? "left-0" : "right-0",
      )}
      aria-hidden
    />
  );
}

/** One Properties row: a muted term and its value. */
function Prop({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-mute">{k}</dt>
      <dd className="m-0 flex min-w-0 items-center text-ink">{children}</dd>
    </>
  );
}

function LinkList({
  items,
  empty,
}: {
  items: { path: string; title: string }[];
  empty: string;
}) {
  if (items.length === 0) {
    return empty ? <p className="m-0 text-[13px] text-mute">{empty}</p> : null;
  }
  return (
    <div className="flex flex-col gap-2.5">
      {items.map((it) => (
        <CLink
          key={it.path}
          path={it.path}
          className={cn(
            "cl-link-plain flex min-w-0 items-center gap-2 rounded text-[14px] text-ink-2 hover:text-ink",
            FOCUS_RING_NATIVE,
          )}
        >
          <KindIcon
            kind={resolveKindAndColor(it.path)}
            tone="mono"
            className="flex-shrink-0"
          />
          <span className="truncate" title={it.path}>
            {it.title}
          </span>
        </CLink>
      ))}
    </div>
  );
}

function resolveKindAndColor(path: string) {
  // list-level kind derives from path only
  return resolveKind({ path });
}
