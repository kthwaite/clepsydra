import { Link, useNavigate, useRouter } from "@tanstack/react-router";
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
  useMemo,
  useRef,
  useState,
} from "react";
import { type Descendant, Element as SlateElement } from "slate";
import {
  useBacklinks,
  useOutlinks,
  useSimilar,
  useTagSuggestions,
  useUnlinkedMentions,
} from "#/api/index";
import { useJournalEditorOptions } from "#/api/journal";
import { type ArchivedPage, useAssignPage } from "#/api/pages";
import type { PageMeta } from "#/api/types";
import { useAttachmentDropUpload } from "#/components/attachments/useAttachmentDropUpload";
import { FolioCalendarSection } from "#/components/calendar/FolioCalendarSection";
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
import { resolveFolioSurface } from "#/components/codex/folioSurface";
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
import { useEmbedTocExpander } from "#/components/codex/useEmbedTocExpander";
import { useFolioMode } from "#/components/codex/useFolioMode";
import { useFolioRestoration } from "#/components/codex/useFolioRestoration";
import { useFolioTab, useTodayJournal } from "#/components/codex/useFolioTab";
import {
  RawMarkdownNavigationGuard,
  useRawMarkdownSession,
} from "#/components/codex/useRawMarkdownSession";
import { useReadingColumn } from "#/components/codex/useReadingColumn";
import { useScrollSpy } from "#/components/codex/useScrollSpy";
import { KindIcon } from "#/components/KindIcon";
import { OfflineUnavailable } from "#/components/OfflineUnavailable";
import { Button } from "#/components/ui/button";
import { IconButton } from "#/components/ui/icon-button";
import { TagInput } from "#/components/ui/tag-input";
import { useOptionalEncryptionActions } from "#/crypto/EncryptionProvider";
import { BaseRenderingProvider } from "#/editor/baseRendering";
import { diagnoseConversationMarkdown } from "#/editor/conversation/marker";
import { ConversationPresentationProvider } from "#/editor/conversation/presentation";
import { insertConversationTurn } from "#/editor/conversation/transforms";
import { slateToMarkdown } from "#/editor/convert";
import { PageEditorHeader, RawMarkdownButton } from "#/editor/PageEditorHeader";
import { SaveIndicator } from "#/editor/SaveIndicator";
import { SlateEditor, type SlateEditorProps } from "#/editor/SlateEditor";
import type { CustomEditor } from "#/editor/types";
import { usePageEditor } from "#/editor/usePageEditor";
import { WikilinkResolutionProvider } from "#/editor/wikilinkResolution";
import { useDebounce } from "#/hooks/useDebounce";
import {
  replaceFolioHistoryAfterArchive,
  useLeaveFolioWorkspace,
} from "#/hooks/useFolioHistoryNavigation";
import { useMobileLayout } from "#/hooks/useMobileLayout";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { aiJournalDateFromPath, journalDateFromPath } from "#/lib/journal";
import { kindDisplayLabel, resolveKind } from "#/lib/kind";
import { presentationFor } from "#/lib/kindPresentation";
import { formatChord, matchesChord, SHORTCUTS } from "#/lib/shortcuts";
import { formatAbsoluteDate, formatRelativeTime } from "#/lib/time";
import { useProjects } from "#/lib/useProjects";
import { isOfflineUncached } from "#/offline/swPolicy";
import {
  parseRecipeMarkdown,
  serializeRecipeMarkdown,
} from "#/recipe/recipeCodec";
import { useFolioDock } from "#/store/folioDock";
import {
  FOLIO_LEFT_RAIL,
  FOLIO_RIGHT_RAIL,
  useFolioRails,
} from "#/store/folioRails";
import { useFooterContext } from "#/store/footerContext";
import { quireColorVar } from "#/store/quires";
import { runWorkspaceTransition, useWorkspaceStore } from "#/store/workspace";

type FolioProps = {
  tabId: string;
  path: string;
};

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
  const todayJournal = useTodayJournal(path);
  const editor = usePageEditor(path, useJournalEditorOptions(path));
  const { data: backlinks } = useBacklinks(path);
  const { data: unlinkedMentions } = useUnlinkedMentions(path);
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
  const onMobileBack = () => {
    if (!router.history.canGoBack()) {
      leaveFolioWorkspace(() => {
        void navigate({ to: "/" });
      });
      return;
    }

    router.history.back();
  };

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
  const folioEditorRef = useRef<CustomEditor | null>(null);
  const {
    conversationMode,
    setConversationMode,
    recipeMode,
    setRecipeMode,
    projectRecipe,
    projectedRecipe,
  } = useFolioMode(path);
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
  const isRecipe = presentation.bodyPresentation === "recipe";
  const recipeParse = useMemo(
    () =>
      isRecipe ? parseRecipeMarkdown(editor.bodyMarkdown, editor.title) : null,
    [editor.bodyMarkdown, editor.title, isRecipe],
  );
  const activeRecipeParse =
    projectedRecipe(editor.editorRevision) ?? recipeParse;
  const recipeDocument =
    activeRecipeParse?.ok === true ? activeRecipeParse.value : null;
  const { session: rawMarkdownSession, ...rawMarkdown } = useRawMarkdownSession(
    {
      path,
      editor,
      onApplied: (markdown) => {
        if (isRecipe) {
          projectRecipe(
            editor.editorRevision,
            parseRecipeMarkdown(markdown, editor.title),
          );
        }
      },
    },
  );
  const encrypted = editor.encrypted === true;
  const encryptionState = editor.encryptionState ?? {
    status: "plain" as const,
    body: editor.bodyMarkdown,
  };
  const {
    surface,
    isAiConversation,
    conversationReadOnly,
    offlineReadOnly,
    bodyProtected,
    locked,
    readOnly: folioReadOnly,
    bodyReadOnly,
    contentAvailable: restorationAvailable,
    rawAvailable: rawMarkdownAvailable,
  } = resolveFolioSurface({
    bodyPresentation: presentation.bodyPresentation,
    conversationMode,
    recipeMode,
    recipeStructured: activeRecipeParse?.ok === true,
    recipeHasBlockIds:
      isRecipe && containsBlockId(editor.editorValue ?? editor.initialValue),
    isLoading: editor.isLoading,
    error: Boolean(editor.error),
    isDraft: editor.isDraft,
    offline: editor.offline === true,
    readonly: editor.readonly === true,
    generatedChangePending: editor.generatedChangePending === true,
    encrypted,
    encryptionStatus: encryptionState.status,
    journalTodayPending: todayJournal.pending,
    rawSessionOpen: rawMarkdownSession !== null,
  });
  const { onEditorUnmount } = useFolioRestoration({
    tabId,
    path,
    available: restorationAvailable,
    rawSessionOpen: rawMarkdownSession !== null,
    editor,
    bodyRef,
    folioEditorRef,
  });
  const { tabQuire, isActiveTab, updateTabPath, closeTab, followMove } =
    useFolioTab({
      tabId,
      path,
      editor,
      todayJournal: todayJournal.target,
      conversationReadOnly,
      bodyRef,
      folioEditorRef,
    });
  const folioProperties = (
    <FolioProperties
      pageId={editor.pageId ?? ""}
      path={path}
      locked={locked}
      readOnly={folioReadOnly}
    />
  );

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
  const visibleEditorValue = locked ? EMPTY_EDITOR_VALUE : currentEditorValue;
  const wordCount = useMemo(
    () => countWordsFromSlate(visibleEditorValue),
    [visibleEditorValue],
  );
  useFooterContext(
    isActiveTab
      ? [
          path,
          ...(wordCount > 0 ? [`${wordCount.toLocaleString()} words`] : []),
        ]
      : null,
  );
  const expandEmbed = useEmbedTocExpander(visibleEditorValue, path);
  const toc = useMemo(
    () => buildToc(visibleEditorValue, expandEmbed),
    [visibleEditorValue, expandEmbed],
  );
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
        archiveOnly={folioReadOnly || locked}
      />
    </Suspense>
  );

  if (surface === "journal-today") {
    return (
      <div className="p-10 text-[13.5px] text-mute">
        Fetching today’s journal…
      </div>
    );
  }
  if (surface === "loading") {
    return <div className="p-10 text-[13.5px] text-mute">Fetching {path}…</div>;
  }
  if (surface === "error") {
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
  // The status check only narrows the state type; "locked" implies it.
  if (surface === "locked" && encryptionState.status !== "plain") {
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

  const saveState =
    folioReadOnly && !archiveTagEditor && editor.revisionConflict ? (
      <span className="text-[12.5px] text-hot">Page changed on disk</span>
    ) : (
      <SaveIndicator
        status={editor.saveStatus}
        error={editor.saveError}
        revisionConflict={editor.revisionConflict}
        onReloadAfterConflict={editor.reloadAfterConflict}
        compact={mobile}
      />
    );
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
        {!mobile && <div className="flex items-center gap-3">{saveState}</div>}
      </div>
    </>
  );

  // Kind-specific facts (a meeting's occurred/attendees) belong beside the
  // title, not in the META rail: they are content, not sidebar metadata.
  const HeaderExtras = presentation.headerExtras;
  const headerExtras = HeaderExtras ? (
    <HeaderExtras path={path} tabId={tabId} isDraft={editor.isDraft} />
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
              ? rawMarkdown.open
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
                ? rawMarkdown.open
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
            <div
              className="my-4 flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-hot/5 px-4 py-3 text-[13.5px] leading-[1.5] text-hot"
              role="alert"
            >
              <span className="min-w-0 flex-1">
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
              <Button
                size="sm"
                className="max-md:h-11"
                onPress={() => setConversationMode("edit")}
              >
                Edit
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {isRecipe && activeRecipeParse?.ok !== true ? (
        <div
          className="my-4 rounded-[12px] bg-hot/5 px-4 py-3 text-[13.5px] leading-[1.5] text-hot"
          role="alert"
        >
          The recipe structure could not be read. The original Markdown is
          preserved in the editor below. To restore structured editing, include
          Ingredients, Steps, and Notes once and in that order as headings of
          one consistent level, with bullet ingredients and numbered steps.
          Components may be grouped under headings one level deeper.
        </div>
      ) : null}

      {surface === "raw-markdown" && rawMarkdownSession ? (
        <RawMarkdownEditor
          value={rawMarkdownSession.value}
          diagnostic={rawMarkdownSession.diagnostic}
          onChange={rawMarkdown.change}
          onApply={() => rawMarkdown.apply(rawMarkdownAvailable)}
          onCancel={rawMarkdown.discard}
        />
      ) : (
        <article
          className={cn(
            "codex-prose mt-9 font-sans text-[17px] leading-[1.7] text-ink-2",
          )}
        >
          {offlineReadOnly ? (
            <OfflineBodyNotice />
          ) : bodyProtected ? (
            <ProtectedBodyNotice onUnlock={() => editor.setReadonly(false)} />
          ) : null}
          <WikilinkResolutionProvider path={path}>
            {surface === "recipe" && recipeDocument ? (
              <RecipeFolioBody
                document={recipeDocument}
                mode={recipeMode}
                onModeChange={setRecipeMode}
                onDocumentChange={(nextDocument) => {
                  projectRecipe(editor.editorRevision, {
                    ok: true,
                    sourceFormat: "markdown",
                    value: nextDocument,
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
                    serializeMarkdown: slateToMarkdown,
                  }}
                >
                  <FolioSlateEditor
                    key={`${path}:${editor.editorRevision}`}
                    initialValue={currentEditorValue}
                    protectedPage={encrypted}
                    onUploaded={() => {
                      setAttachmentsOpen(true);
                      useFolioRails
                        .getState()
                        .setCollapsed(FOLIO_LEFT_RAIL, false);
                    }}
                    onChange={editor.onSlateChange}
                    onSaveNow={editor.saveNow}
                    insertionRequest={attachmentInsertion}
                    onInsertionHandled={finishAttachmentInsertion}
                    readOnly={bodyReadOnly}
                    journalDate={
                      journalDateFromPath(path) ?? aiJournalDateFromPath(path)
                    }
                    editorRef={folioEditorRef}
                    onUnmountSnapshot={onEditorUnmount}
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
            <span>{kindDisplayLabel(kind)}</span>
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
              menuTrigger="focus"
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
            <Extras path={path} tabId={tabId} isDraft={editor.isDraft} />
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
              <span>Page actions</span>
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
  const unlinked = unlinkedMentions ?? [];
  // The index returns one row per link; the rail shows one card per source,
  // and never the page itself (its own aliases index as property links).
  const linkedFrom = (backlinks ?? []).filter(
    (b, i, all) =>
      b.source_path !== path &&
      all.findIndex((o) => o.source_path === b.source_path) === i,
  );
  const calendar = (
    <FolioCalendarSection
      path={path}
      kind={editor.kind}
      createdAt={editor.createdAt}
    />
  );
  const relationships = (
    <>
      <Section compact label="Linked from" caption={String(linkedFrom.length)}>
        {linkedFrom.length === 0 ? (
          <p className="m-0 text-[13px] text-mute">No pages link here yet.</p>
        ) : (
          <div className="flex flex-col gap-6">
            {linkedFrom.map((b) => (
              <RailLinkEntry
                key={b.source_path}
                path={b.source_path}
                title={b.source_title || b.source_path}
                context={b.context}
                needles={[...b.target_raw.split("|"), editor.title ?? ""]}
              />
            ))}
          </div>
        )}
      </Section>

      {unlinked.length > 0 ? (
        <Section
          compact
          pip="dim"
          label="Unlinked mentions"
          caption={String(unlinked.length)}
        >
          <div className="flex flex-col gap-6">
            {unlinked.map((m) => (
              <RailLinkEntry
                key={m.source_path}
                path={m.source_path}
                title={m.source_title || m.source_path}
                context={m.context}
                needles={[m.matched]}
              />
            ))}
          </div>
        </Section>
      ) : null}

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
          dirty={rawMarkdown.dirty}
          onLeave={rawMarkdown.discard}
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
          group={
            tabQuire
              ? { name: tabQuire.name, color: quireColorVar(tabQuire.color) }
              : null
          }
          status={saveState}
          linkedCount={linkedFrom.length}
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
      calendar={calendar}
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

// Shares the editor's page/revision key so a pending drop cannot outlive its body.
function FolioSlateEditor({
  protectedPage,
  onUploaded,
  ...props
}: SlateEditorProps & {
  protectedPage: boolean;
  onUploaded: () => void;
}) {
  const { uploadFiles, feedback } = useAttachmentDropUpload({
    protectedPage,
    onUploaded,
    disabled: props.readOnly,
  });
  return (
    <>
      <SlateEditor {...props} onFilesDrop={uploadFiles} />
      {feedback}
    </>
  );
}

/** Width of a panel docked in the right column (the base embed inspector). */
const DOCK_WIDTH = 400;

function DesktopFolioLayout({
  header,
  document,
  details,
  calendar,
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
  /** Desktop only: the mobile layout has no right rail for it (Q3). */
  calendar: React.ReactNode;
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
  const rightDock = useFolioDock((s) => s.rightDock);
  const lw = left.collapsed ? 32 : left.width;
  const rw = rightDock ? DOCK_WIDTH : right.collapsed ? 32 : right.width;

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

      {rightDock ? (
        // The docked panel is fixed over this slot; it only reserves room.
        <div aria-hidden data-folio-dock-slot />
      ) : right.collapsed ? (
        <RailStub side="right" onExpand={right.toggle} />
      ) : (
        <aside
          aria-label="Page links"
          className="cl-noscroll relative flex min-w-0 flex-col gap-7 overflow-auto pt-16 pb-10"
        >
          <Resizer onPointerDown={right.onResizeStart} side="left" />
          <RailHideButton side="right" onCollapse={right.toggle} />
          {calendar}
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

/** A rail entry for a page that refers to this one: serif title, then the
 *  surrounding text with the reference highlighted. */
function RailLinkEntry({
  path,
  title,
  context,
  needles,
}: {
  path: string;
  title: string;
  context: string | null | undefined;
  needles: string[];
}) {
  return (
    <CLink
      path={path}
      className={cn(
        "cl-link-plain flex flex-col gap-1.5 rounded",
        FOCUS_RING_NATIVE,
      )}
    >
      <span
        data-link-title
        className="font-serif text-[21px] leading-[1.2] text-ink"
      >
        {title}
      </span>
      {context ? (
        <span
          data-link-snippet
          className="text-[13.5px] leading-[1.55] text-mute"
        >
          {highlightMatch(plainWikiText(context), needles)}
        </span>
      ) : null}
    </CLink>
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
