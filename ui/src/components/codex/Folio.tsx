import {
  Link,
  useBlocker,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  useState,
} from "react";
import {
  type Descendant,
  Editor,
  type Range,
  Element as SlateElement,
  Transforms,
} from "slate";
import { ReactEditor } from "slate-react";
import {
  useBacklinks,
  useOutlinks,
  useSimilar,
  useTagSuggestions,
} from "#/api/index";
import type { PageMeta } from "#/api/types";
import { useJournalEditorOptions, useJournalToday } from "#/api/journal";
import { type ArchivedPage, useAssignPage } from "#/api/pages";
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
import { KindSelect } from "#/components/codex/KindSelect";
import { LockedFolio } from "#/components/codex/LockedFolio";
import { MobileFolioLayout } from "#/components/codex/MobileFolioLayout";
import { ProjectCombo } from "#/components/codex/ProjectCombo";
import { RawMarkdownEditor } from "#/components/codex/RawMarkdownEditor";
import { useSetReadingProgress } from "#/components/codex/ReadingProgressContext";
import { RecipeFolioBody } from "#/components/codex/recipe/RecipeFolioBody";
import { useCollapsibleRail } from "#/components/codex/useCollapsibleRail";
import { useScrollSpy } from "#/components/codex/useScrollSpy";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { useOptionalEncryptionActions } from "#/crypto/EncryptionProvider";
import { diagnoseConversationMarkdown } from "#/editor/conversation/marker";
import { ConversationPresentationProvider } from "#/editor/conversation/presentation";
import { insertConversationTurn } from "#/editor/conversation/transforms";
import { PageEditorHeader } from "#/editor/PageEditorHeader";
import { SaveIndicator } from "#/editor/SaveIndicator";
import { SlateEditor } from "#/editor/SlateEditor";
import type { CustomEditor } from "#/editor/types";
import { usePageEditor } from "#/editor/usePageEditor";
import { WikilinkResolutionProvider } from "#/editor/wikilinkResolution";
import { useDebounce } from "#/hooks/useDebounce";
import {
  registerFolioHistoryTraversalGuard,
  replaceFolioHistoryAfterArchive,
  useActivateTabWithFolioHistory,
  useLeaveFolioWorkspace,
} from "#/hooks/useFolioHistoryNavigation";
import { useMobileLayout } from "#/hooks/useMobileLayout";
import { cn } from "#/lib/cn";
import { todayJournalPath } from "#/lib/journal";
import { kindColorVar, kindLabel, resolveKind } from "#/lib/kind";
import { presentationFor } from "#/lib/kindPresentation";
import { matchesChord, SHORTCUTS } from "#/lib/shortcuts";
import { formatAbsoluteDate, formatRelativeTime } from "#/lib/time";
import { useProjects } from "#/lib/useProjects";
import {
  parseRecipeMarkdown,
  type RecipeParseResult,
  serializeRecipeMarkdown,
} from "#/recipe/recipeCodec";
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
import {
  registerWorkspaceTransitionGuard,
  runWorkspaceTransition,
  type TabDescriptor,
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
    const unregisterWorkspaceGuard =
      registerWorkspaceTransitionGuard(guard);
    const unregisterHistoryGuard =
      registerFolioHistoryTraversalGuard(guard);
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
      <p className="text-sm text-muted-foreground">
        This raw draft exists only in this browser until you Apply it.
      </p>
    </Dialog>
  );
}

const R_TAB_KEY = "clp.folio.r.tab";
type RTab = "backlinks" | "links" | "tags";
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
  const leaveFolioWorkspace = useLeaveFolioWorkspace();
  const isTodayDraftPath = path === todayJournalPath();
  const { data: journalToday, isLoading: isJournalTodayLoading } =
    useJournalToday(isTodayDraftPath);
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
      replaceFolioHistoryAfterArchive(router.history);
      if (mobile) void navigate({ to: "/" });
    },
    [closeArchivedPageTabs, mobile, navigate, router.history],
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
      focus: selection
        ? snapshotTextPoint(slateEditor, selection.focus)
        : null,
    };
  }, [path, tabId]);

  useLayoutEffect(
    () =>
      registerFolioHistoryCapture(tabId, path, buildRestorationSnapshot),
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
  useEffect(() => {
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

  const [rTab, setRTab] = useState<RTab>(() => {
    try {
      const v = window.localStorage.getItem(R_TAB_KEY);
      if (v === "backlinks" || v === "links" || v === "tags") return v;
    } catch {
      // ignore
    }
    return "backlinks";
  });
  const selectRTab = (t: RTab) => {
    setRTab(t);
    try {
      window.localStorage.setItem(R_TAB_KEY, t);
    } catch {
      // ignore
    }
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
  const bodyProtected = editor.readonly === true;
  const folioReadOnly = conversationReadOnly || recipeReadOnly || bodyProtected;
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
    (!encrypted || encryptionState.status === "plain") &&
    !(isTodayDraftPath && (isJournalTodayLoading || journalToday));
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
    editor.editorRevision,
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
    if (folioEditorRef.current) {
      lastMountedFolioEditorRef.current = folioEditorRef.current;
    }
  }, [editor.editorRevision, path]);

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
        const requireTextMatch =
          restoration.revision !== editor.getRevision();
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
    <Suspense fallback={<p className="cl-marg mb-0">Loading page actions…</p>}>
      <PageActionsMenu
        path={path}
        beforeMutation={editor.saveNow}
        onMoved={(nextPath) => updateTabPath(tabId, nextPath)}
        onArchived={handleArchived}
        archiveOnly={
          folioReadOnly ||
          (encrypted && encryptionState.status !== "plain")
        }
      />
    </Suspense>
  );

  if (
    !rawMarkdownSession &&
    isTodayDraftPath &&
    (isJournalTodayLoading || journalToday)
  ) {
    return <div className="cl-marg p-6">… fetching today’s journal …</div>;
  }
  if (!rawMarkdownSession && editor.isLoading) {
    return <div className="cl-marg p-6">… fetching folio {path} …</div>;
  }
  if (!rawMarkdownSession && editor.error && !editor.isDraft) {
    // Only a settled 404 means the file is actually gone; any other query
    // error is a load failure the user can retry without losing the tab.
    if (editor.pageNotFound) {
      return <FolioNotFound path={path} onClose={() => closeTab(tabId)} />;
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
        <span className="cl-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute">
          FILE / {folioCode}
        </span>
        <div className="flex items-center gap-3">
          <span className="cl-mono inline-flex items-center gap-1.5 text-[9px] uppercase tracking-[0.16em] text-ink-mute">
            <Pip kind={kind} />
            {kindLabel(kind)}
          </span>
          {folioReadOnly && editor.revisionConflict ? (
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
      <hr className="cl-rule-dash mt-2" />
    </>
  );

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
            tagSuggestionsLoading={
              tagSuggestionQuery.length > 0 &&
              (!tagSuggestionsCurrent ||
                tagSuggestionRequest.isLoading ||
                tagSuggestionRequest.isFetching)
            }
            tagSuggestionsError={
              tagSuggestionsCurrent &&
              !tagSuggestionRequest.isFetching &&
              tagSuggestionRequest.error
                ? new Error(tagSuggestionRequest.error.error)
                : null
            }
            onRetryTagSuggestions={tagSuggestionRequest.refetch}
            onTagsChange={editor.setTags}
            aliases={editor.aliases}
            onAliasesChange={editor.setAliases}
            onSaveNow={editor.saveNow}
            encrypted={encrypted}
            onRequestLock={
              rawMarkdownSession ? undefined : encryptionActions?.lock
            }
          />
        </div>
      )}
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
          Ingredients, Steps, and Notes once and in that order, with bullet
          ingredients and numbered steps. Either uppercase markers with •
          bullets or consistent Markdown headings and lists are accepted.
        </div>
      ) : null}

      {rawMarkdownAvailable && !rawMarkdownSession ? (
        <div className="mt-3 flex justify-end">
          <Button variant="secondary" size="sm" onPress={openRawMarkdown}>
            Raw Markdown
          </Button>
        </div>
      ) : null}

      <hr className="cl-rule-dash mt-3" />

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
            "codex-prose mt-5 font-sans text-[17px] leading-[1.65]",
            isAiConversation && `ai-conversation--${conversationMode}`,
          )}
        >
          {bodyProtected ? (
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
                      sourceFormat: "example",
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
                <SlateEditor
                  key={`${path}:${editor.editorRevision}`}
                  initialValue={currentEditorValue}
                  onChange={editor.onSlateChange}
                  onSaveNow={editor.saveNow}
                  insertionRequest={attachmentInsertion}
                  onInsertionHandled={finishAttachmentInsertion}
                  readOnly={conversationReadOnly || bodyProtected}
                  editorRef={folioEditorRef}
                  onUnmountSnapshot={handleEditorSwapSnapshot}
                />
              </ConversationPresentationProvider>
            )}
          </WikilinkResolutionProvider>
        </article>
      )}

      <hr className="cl-rule-dash mt-8" />
      <div className="cl-mono mt-1 flex justify-between text-[9px] uppercase tracking-[0.16em] text-ink-mute">
        <span>END OF FILE</span>
        <span>
          {folioCode} · {wordCount > 0 ? `${wordCount} WD` : "—"}
        </span>
      </div>
    </>
  );

  const details = (
    <>
      <Block label="Document">
        <KV k="ID" v={folioCode} />
        <KV
          k="Kind"
          v={
            folioReadOnly ? (
              <span>{kindLabel(kind)}</span>
            ) : (
              <KindSelect
                value={kind}
                inferred={inferred}
                immutableReason={
                  kind === "JOURNAL"
                    ? "Journal kind cannot be changed."
                    : undefined
                }
                onAssign={(k) =>
                  assign.mutate(
                    { params: { path: { path } }, body: { kind: k } },
                    { onSuccess: followMove },
                  )
                }
              />
            )
          }
        />
        <KV
          k="Project"
          v={
            folioReadOnly ? (
              <span>{project ?? "—"}</span>
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
            )
          }
        />
        <KV
          k="Path"
          v={<span className="break-all text-ink-mute">{path}</span>}
        />
        <KV
          k="Protection"
          v={
            folioReadOnly ? (
              <span>{encrypted ? "encrypted" : "plaintext"}</span>
            ) : (
              <button
                type="button"
                className="cl-mono text-[10px] uppercase tracking-[0.1em] text-accent hover:underline"
                disabled={!editor.pageId}
                onClick={() =>
                  setProtectionDialog(encrypted ? "unprotect" : "protect")
                }
              >
                {encrypted ? "encrypted · remove" : "plaintext · protect"}
              </button>
            )
          }
        />
      </Block>
    </>
  );

  const supplementalDetails = (
    <>
      <Block label="Chronology">
        <KV k="Created" v={formatAbsoluteDate(editor.createdAt)} />
        <KV k="Modified" v={formatRelativeTime(editor.updatedAt)} />
      </Block>

      <Block label="Vitals">
        <KV k="Words" v={wordCount > 0 ? wordCount : "—"} />
        <KV k="Backlinks" v={backlinks?.length ?? 0} />
        <KV k="Links" v={visibleOutlinks.length} />
      </Block>

      {(() => {
        const Extras = presentation.metaExtras;
        return Extras ? (
          <Block label={presentation.metaExtrasLabel ?? "Details"}>
            <Extras path={path} tabId={tabId} isDraft={editor.isDraft} />
          </Block>
        ) : null;
      })()}

      <Block label="Attachments">
        {folioReadOnly ? (
          <p className="cl-marg m-0">Switch to Edit to manage attachments.</p>
        ) : (
          <>
            <button
              type="button"
              aria-expanded={attachmentsOpen}
              className="cl-mono flex w-full cursor-pointer items-center justify-between text-[10px] uppercase tracking-[0.1em] text-ink-mute hover:text-accent"
              onClick={() => setAttachmentsOpen((open) => !open)}
            >
              <span>Manage attachments</span>
              <span aria-hidden>{attachmentsOpen ? "⌄" : "›"}</span>
            </button>
            {attachmentsOpen ? (
              <Suspense
                fallback={
                  <p className="cl-marg mt-2 mb-0">Loading attachment tools…</p>
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
      </Block>

      <Block label="Organization">
        {editor.isDraft ? (
          <p className="cl-marg m-0">
            Save this page before moving or archiving it.
          </p>
        ) : folioReadOnly ? (
          <div className="grid gap-2">
            <p className="cl-marg m-0">
              Switch to Edit to move this page. Archiving remains available.
            </p>
            {pageActions}
          </div>
        ) : (
          <>
            <button
              type="button"
              aria-expanded={organizationOpen}
              className="cl-mono flex w-full cursor-pointer items-center justify-between text-[10px] uppercase tracking-[0.1em] text-ink-mute hover:text-accent"
              onClick={() => setOrganizationOpen((open) => !open)}
            >
              <span>Manage paths</span>
              <span aria-hidden>{organizationOpen ? "⌄" : "›"}</span>
            </button>
            {organizationOpen ? (
              <Suspense
                fallback={
                  <p className="cl-marg mt-2 mb-0">Loading path tools…</p>
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
      </Block>

      <OpenFilesAccordion activeTabId={tabId} />
    </>
  );

  const contents = (
    <Block label={`Contents · ${toc.length}`}>
      {toc.length === 0 ? (
        <p className="cl-marg m-0">No headings yet.</p>
      ) : (
        <div className="cl-mono">
          {toc.map((h, i) => {
            const active = i === activeIndex;
            return (
              <button
                key={`${h.text}-${i}`}
                type="button"
                onClick={() => scrollTo(i)}
                className={cn(
                  "flex w-full cursor-pointer items-baseline gap-1.5 py-[2px] pr-1 text-left text-[11px]",
                  active
                    ? "border-l-2 border-accent bg-highlight pl-2 text-ink"
                    : "border-l-2 border-transparent pl-2 text-ink-mute hover:text-ink",
                )}
                style={{ paddingLeft: (h.depth - 1) * 8 + 8 }}
              >
                <span className="text-[9px] text-ink-mute">{h.number}</span>
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                  {h.text}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Block>
  );

  const relationships = (
    <>
      <div className="flex items-stretch border-b border-rule">
        <RTabBtn
          label="Backlinks"
          n={backlinks?.length ?? 0}
          active={rTab === "backlinks"}
          onClick={() => selectRTab("backlinks")}
        />
        <RTabBtn
          label="Links"
          n={visibleOutlinks.length}
          active={rTab === "links"}
          onClick={() => selectRTab("links")}
        />
        <RTabBtn
          label="Tags"
          n={(editor.tags ?? []).length}
          active={rTab === "tags"}
          onClick={() => selectRTab("tags")}
        />
        <span className="flex-1" />
      </div>

      <div className="px-3 py-3">
        {rTab === "backlinks" && (
          <LinkList
            empty="No backlinks — this folio stands alone."
            items={(backlinks ?? []).map((b) => ({
              path: b.source_path,
              title: b.source_title || b.source_path,
            }))}
          />
        )}
        {rTab === "links" && (
          <>
            <LinkList
              empty="No outbound links yet."
              items={visibleOutlinks.map((o) => ({
                path: o.target_path,
                title: o.target_raw || o.target_path,
              }))}
            />
            {(similar?.items.length ?? 0) > 0 && (
              <>
                <div className="cl-mono mt-4 mb-1 text-[9px] uppercase tracking-[0.18em] text-ink-mute">
                  ≈ Similar
                </div>
                <LinkList
                  empty=""
                  items={(similar?.items ?? []).map((s) => ({
                    path: s.path,
                    title: s.title || s.path,
                  }))}
                />
              </>
            )}
          </>
        )}
        {rTab === "tags" &&
          ((editor.tags ?? []).length === 0 ? (
            <p className="cl-marg m-0">∅ No tags.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {(editor.tags ?? []).map((t) => (
                <span
                  key={t}
                  className="cl-mono border border-rule px-1.5 py-[1px] text-[10px] uppercase tracking-[0.08em] text-ink-2"
                >
                  {t}
                </span>
              ))}
            </div>
          ))}
      </div>
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
    storageKey: "clp.folio.l",
    side: "left",
    defaultWidth: 240,
    min: 180,
    max: 480,
  });
  const right = useCollapsibleRail({
    storageKey: "clp.folio.r",
    side: "right",
    defaultWidth: 280,
    min: 220,
    max: 480,
  });
  const lw = left.collapsed ? 34 : left.width;
  const rw = right.collapsed ? 34 : right.width;

  return (
    <div
      className="grid h-full min-h-0"
      style={{ gridTemplateColumns: `${lw}px 1fr ${rw}px` }}
    >
      {left.collapsed ? (
        <RailStub label="META" side="left" onExpand={left.toggle} />
      ) : (
        <aside className="cl-noscroll relative overflow-auto border-r border-rule">
          <RailHeader label="META" onCollapse={left.toggle} side="left" />
          {details}
          {contents}
          {supplementalDetails}
          <Resizer onPointerDown={left.onResizeStart} side="right" />
        </aside>
      )}

      <div className="relative min-h-0">
        <div
          ref={bodyRef}
          onScroll={onScroll}
          className="cl-noscroll h-full overflow-auto"
        >
          <div className="mx-auto max-w-[900px] px-7 py-[18px] pb-10">
            {header}
            {document}
          </div>
        </div>
        <ReadingTicks toc={toc} activeIndex={activeIndex} onJump={onJump} />
      </div>

      {right.collapsed ? (
        <RailStub label="LINKS" side="right" onExpand={right.toggle} />
      ) : (
        <aside className="cl-noscroll relative overflow-auto border-l border-rule">
          <Resizer onPointerDown={right.onResizeStart} side="left" />
          {relationships}
          <button
            type="button"
            onClick={right.toggle}
            className="cl-mono absolute top-0 right-0 cursor-pointer px-2 py-1.5 text-[12px] text-ink-mute hover:text-ink"
            aria-label="collapse panel"
          >
            ›
          </button>
        </aside>
      )}
      {protection}
    </div>
  );
}

function ReadOnlyPageHeader({
  path,
  title,
  tags,
  aliases,
  archive,
  encrypted,
}: {
  path: string;
  title: string;
  tags: string[];
  aliases: string[];
  archive: NonNullable<PageMeta["archive"]> | null;
  encrypted: boolean;
}) {
  const displayTitle = title || path.split("/").pop() || path;
  return (
    <section
      aria-label="Page metadata"
      className="mt-4 pb-4 max-md:flex max-md:flex-col max-md:gap-3"
    >
      {encrypted ? (
        <span className="cl-mono mb-2 block text-[9px] uppercase tracking-[0.14em] text-ink-mute">
          encrypted
        </span>
      ) : null}
      <h1 className="w-full font-heading text-2xl font-bold">{displayTitle}</h1>
      {archive?.snapshot_hash ? (
        <Link
          to="/archive/$"
          params={{ _splat: path }}
          className="cl-mono mt-2 inline-block text-[10px] uppercase tracking-[0.14em] text-accent underline decoration-accent-deep underline-offset-4 hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-accent"
        >
          View archived snapshot
        </Link>
      ) : null}
      <dl className="cl-mono mt-2 grid gap-2 text-[10px]">
        <div className="flex flex-wrap items-baseline gap-2">
          <dt className="uppercase tracking-[0.12em] text-ink-mute">Tags</dt>
          <dd className="m-0 flex flex-wrap gap-1.5 text-ink-2">
            {tags.length > 0
              ? tags.map((tag) => (
                  <span
                    key={tag}
                    className="border border-rule px-1.5 py-[1px]"
                  >
                    {tag}
                  </span>
                ))
              : "—"}
          </dd>
        </div>
        {aliases.length > 0 ? (
          <div className="flex flex-wrap items-baseline gap-2">
            <dt className="uppercase tracking-[0.12em] text-ink-mute">
              Aliases
            </dt>
            <dd className="m-0 flex flex-wrap gap-1.5 text-ink-2">
              {aliases.map((alias) => (
                <span
                  key={alias}
                  className="border border-rule px-1.5 py-[1px]"
                >
                  {alias}
                </span>
              ))}
            </dd>
          </div>
        ) : null}
      </dl>
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
            key={`${h.text}-${i}`}
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
                "h-[3px] transition-all",
                active
                  ? "w-7 bg-accent"
                  : "w-3.5 bg-ink-mute/40 group-hover:w-5 group-hover:bg-ink",
              )}
            />
          </button>
        );
      })}
    </nav>
  );
}

function ProtectedBodyNotice({ onUnlock }: { onUnlock: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div
      role="status"
      className="mb-4 flex items-center justify-between gap-3 border border-rule px-3 py-2 text-[13px] text-ink-2"
    >
      <span>
        This page is a captured archive. Its body is kept as captured so the
        recorded content hash stays true.
      </span>
      <Button
        className="shrink-0 border border-rule px-2 py-1 text-[12px] hover:bg-highlight disabled:opacity-50"
        isDisabled={busy}
        onPress={async () => {
          setBusy(true);
          try {
            await onUnlock();
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

function Pip({ kind }: { kind: Parameters<typeof kindColorVar>[0] }) {
  return (
    <span
      className="inline-block h-[6px] w-[6px] flex-shrink-0"
      style={{ background: kindColorVar(kind) }}
      aria-hidden
    />
  );
}

function RailHeader({
  label,
  onCollapse,
  side,
}: {
  label: string;
  onCollapse: () => void;
  side: "left" | "right";
}) {
  return (
    <div className="sticky top-0 z-10 flex items-center justify-between border-b border-rule bg-paper px-3 py-1">
      <span className="cl-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute">
        {label}
      </span>
      <button
        type="button"
        onClick={onCollapse}
        className="cl-mono cursor-pointer text-[12px] text-ink-mute hover:text-ink"
        aria-label={`collapse ${label}`}
      >
        {side === "left" ? "‹" : "›"}
      </button>
    </div>
  );
}

function RailStub({
  label,
  side,
  onExpand,
}: {
  label: string;
  side: "left" | "right";
  onExpand: () => void;
}) {
  return (
    <aside
      className={cn(
        "flex justify-center border-rule pt-3",
        side === "left" ? "border-r" : "border-l",
      )}
    >
      <button
        type="button"
        onClick={onExpand}
        className="cl-mono cursor-pointer text-[9px] uppercase tracking-[0.18em] text-ink-mute hover:text-ink [writing-mode:vertical-rl]"
        aria-label={`expand ${label}`}
      >
        {label} {side === "left" ? "›" : "‹"}
      </button>
    </aside>
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
        "absolute top-0 z-20 h-full w-[3px] cursor-col-resize hover:bg-accent",
        side === "left" ? "left-0" : "right-0",
      )}
      aria-hidden
    />
  );
}

function Block({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-rule-soft px-3 py-3">
      <div className="cl-mono mb-1.5 text-[9px] uppercase tracking-[0.18em] text-ink-mute">
        {label}
      </div>
      {children}
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="cl-mono grid grid-cols-[64px_1fr] items-center gap-2 py-[1px] text-[11px]">
      <span className="text-[9px] uppercase tracking-[0.12em] text-ink-mute">
        {k}
      </span>
      <span className="flex min-w-0 items-center text-ink-2">{v}</span>
    </div>
  );
}

function RTabBtn({
  label,
  n,
  active,
  onClick,
}: {
  label: string;
  n: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "cl-mono flex cursor-pointer items-center gap-1.5 border-r border-rule-soft px-2.5 py-1.5 text-[9px] uppercase tracking-[0.14em]",
        active
          ? "text-ink shadow-[inset_0_-2px_0_0_var(--accent)]"
          : "text-ink-mute hover:text-ink",
      )}
    >
      {label}
      <span className={active ? "text-accent" : "text-ink-mute"}>{n}</span>
    </button>
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
    return empty ? <p className="cl-marg m-0">{empty}</p> : null;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {items.map((it) => (
        <div key={it.path} className="grid grid-cols-[16px_1fr] gap-1.5">
          <Pip kind={resolveKindAndColor(it.path)} />
          <div className="min-w-0">
            <CLink path={it.path} className="block text-[12px] text-ink">
              {it.title}
            </CLink>
            <span className="cl-mono block text-[9px] text-ink-mute">
              {shortFolio(it.path)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function resolveKindAndColor(path: string) {
  // list-level kind derives from path only
  return resolveKind({ path });
}

/* ── open-files vertical accordion ────────────────────────────────────── */

function OpenFilesAccordion({ activeTabId }: { activeTabId: string }) {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const activateTab = useActivateTabWithFolioHistory();
  const [open, setOpen] = useState(true);

  const recent = tabs
    .filter((tab) => tab.type === "page")
    .sort(
      (left, right) => (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0),
    );

  return (
    <div className="border-b border-rule-soft px-3 py-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="cl-mono mb-1.5 flex w-full cursor-pointer items-center justify-between text-[9px] uppercase tracking-[0.18em] text-ink-mute hover:text-ink"
      >
        <span>Open files · {recent.length}</span>
        <span>{open ? "⌄" : "›"}</span>
      </button>
      {open && (
        <Section title="Recent">
          {recent.length === 0 ? (
            <p className="cl-marg m-0">None open.</p>
          ) : (
            recent.map((tab) => (
              <OpenRow
                key={tab.id}
                t={tab}
                active={tab.id === activeTabId}
                onActivate={() => activateTab(tab.id)}
                onClose={() => closeTab(tab.id)}
              />
            ))
          )}
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-1.5">
      <div className="cl-mono mb-0.5 text-[8px] uppercase tracking-[0.2em] text-ink-mute opacity-70">
        {title}
      </div>
      {children}
    </div>
  );
}

function OpenRow({
  t,
  active,
  onActivate,
  onClose,
}: {
  t: TabDescriptor;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const kind = resolveKind({ path: t.path ?? "" });
  return (
    <div
      className={cn(
        "group flex w-full items-center gap-1.5 py-[2px] text-[11px]",
        active ? "text-ink" : "text-ink-mute",
      )}
    >
      <button
        type="button"
        onClick={onActivate}
        title={t.path ?? t.label}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left hover:text-ink"
      >
        <Pip kind={kind} />
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">
          {t.label || t.path || "(untitled)"}
        </span>
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close tab"
        title="Close"
        className="cl-mono flex-shrink-0 cursor-pointer px-1 text-[11px] text-ink-mute opacity-0 hover:text-hot group-hover:opacity-100"
      >
        ×
      </button>
    </div>
  );
}
