import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useBacklinks, useOutlinks, useSimilar } from "#/api/index";
import { useJournalEditorOptions, useJournalToday } from "#/api/journal";
import { useAssignPage } from "#/api/pages";
import { CLink } from "#/components/codex/CLink";
import { FolioNotFound } from "#/components/codex/FolioNotFound";
import {
  countWordsFromSlate,
  shortFolio,
} from "#/components/codex/folio-utils";
import { KindSelect } from "#/components/codex/KindSelect";
import { LockedFolio } from "#/components/codex/LockedFolio";
import { ProjectCombo } from "#/components/codex/ProjectCombo";
import { useReadingProgress } from "#/components/codex/ReadingProgressContext";
import { useCollapsibleRail } from "#/components/codex/useCollapsibleRail";
import { useScrollSpy } from "#/components/codex/useScrollSpy";
import { useOptionalEncryptionActions } from "#/crypto/EncryptionProvider";
import { PageEditorHeader } from "#/editor/PageEditorHeader";
import { SaveIndicator } from "#/editor/SaveIndicator";
import { SlateEditor } from "#/editor/SlateEditor";
import { usePageEditor } from "#/editor/usePageEditor";
import { WikilinkResolutionProvider } from "#/editor/wikilinkResolution";
import { cn } from "#/lib/cn";
import { kindColorVar, kindLabel, resolveKind } from "#/lib/kind";
import { presentationFor } from "#/lib/kindPresentation";
import { matchesChord, SHORTCUTS } from "#/lib/shortcuts";
import { todayJournalPath } from "#/lib/journal";
import { formatAbsoluteDate, formatRelativeTime } from "#/lib/time";
import { useProjects } from "#/lib/useProjects";
import { type TabDescriptor, useWorkspaceStore } from "#/store/workspace";

type FolioProps = {
  tabId: string;
  path: string;
};

const R_TAB_KEY = "clp.folio.r.tab";
type RTab = "backlinks" | "links" | "tags";
const EMPTY_EDITOR_VALUE: [] = [];

const NoteProtectionDialog = lazy(() =>
  import("#/components/codex/NoteProtectionDialog").then((module) => ({
    default: module.NoteProtectionDialog,
  })),
);

export function Folio({ tabId, path }: FolioProps) {
  const isTodayDraftPath = path === todayJournalPath();
  const { data: journalToday, isLoading: isJournalTodayLoading } =
    useJournalToday(isTodayDraftPath);
  const editor = usePageEditor(path, useJournalEditorOptions(path));
  const { data: backlinks } = useBacklinks(path);
  const { data: outlinks } = useOutlinks(path);
  const { data: similar } = useSimilar(path);
  const updateTabLabel = useWorkspaceStore((s) => s.updateTabLabel);
  const updateTabPath = useWorkspaceStore((s) => s.updateTabPath);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  useEffect(() => {
    if (
      isTodayDraftPath &&
      journalToday?.path &&
      journalToday.path !== path
    ) {
      updateTabPath(
        tabId,
        journalToday.path,
        journalToday.meta.title ?? undefined,
      );
    }
  }, [isTodayDraftPath, journalToday, path, tabId, updateTabPath]);

  const assign = useAssignPage();
  const projects = useProjects();
  const { setProgress } = useReadingProgress();
  const encryptionActions = useOptionalEncryptionActions();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [protectionDialog, setProtectionDialog] = useState<
    "protect" | "unprotect" | null
  >(null);

  // Assigning a kind/project writes frontmatter AND moves the file, so the
  // page path changes. Repoint the open tab to the new path; because FOLIO is
  // keyed on the tab path (TabContent), this remounts the editor at the new
  // location — the entire follow mechanism.
  const followMove = (data: { path?: string }) => {
    if (data.path && data.path !== path) updateTabPath(tabId, data.path);
  };

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

  // ⌘S / Ctrl-S flushes a save from anywhere in the folio (title, tags,
  // rails) — not just the editor body — and suppresses the browser dialog.
  const saveNow = editor.saveNow;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (matchesChord(e, SHORTCUTS["folio.save"].chord)) {
        e.preventDefault();
        void saveNow().catch(() => undefined);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveNow]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    setProgress(max > 0 ? Math.min(1, el.scrollTop / max) : 0);
  };

  const folioCode = shortFolio(path);
  const kind = useMemo(
    () => resolveKind({ path, kind: editor.kind, body: editor.bodyMarkdown }),
    [path, editor.kind, editor.bodyMarkdown],
  );
  const isJournal = kind === "JOURNAL";
  const editableTags = useMemo(
    () =>
      isJournal
        ? editor.tags.filter((tag) => tag.toLowerCase() !== "journal")
        : editor.tags,
    [isJournal, editor.tags],
  );
  const hasPersistedJournalTag =
    isJournal && editableTags.length !== editor.tags.length;
  useEffect(() => {
    if (editor.isLoading || !hasPersistedJournalTag) return;
    editor.setTags(editableTags);
  }, [
    editor.isLoading,
    editor.setTags,
    editableTags,
    hasPersistedJournalTag,
  ]);
  const presentation = presentationFor(kind);
  const inferred = editor.inferred;
  const project = editor.project;
  const encrypted = editor.encrypted === true;
  const encryptionState = editor.encryptionState ?? {
    status: "plain" as const,
    body: editor.bodyMarkdown,
  };
  const visibleEditorValue =
    encrypted && encryptionState.status !== "plain"
      ? EMPTY_EDITOR_VALUE
      : editor.initialValue;
  const wordCount = useMemo(
    () => countWordsFromSlate(visibleEditorValue),
    [visibleEditorValue],
  );
  const toc = useMemo(() => buildToc(visibleEditorValue), [visibleEditorValue]);
  const { activeIndex, scrollTo } = useScrollSpy(
    bodyRef,
    editor.editorRevision,
  );

  if (isTodayDraftPath && (isJournalTodayLoading || journalToday)) {
    return <div className="cl-marg p-6">… fetching today’s journal …</div>;
  }
  if (editor.isLoading) {
    return <div className="cl-marg p-6">… fetching folio {path} …</div>;
  }
  if (editor.error && !editor.isDraft) {
    return <FolioNotFound path={path} onClose={() => closeTab(tabId)} />;
  }
  if (encrypted && encryptionState.status !== "plain") {
    return (
      <LockedFolio
        path={path}
        title={editor.title}
        tags={editor.tags ?? []}
        state={encryptionState}
      />
    );
  }

  const lw = left.collapsed ? 34 : left.width;
  const rw = right.collapsed ? 34 : right.width;

  return (
    <div
      className="grid h-full min-h-0"
      style={{ gridTemplateColumns: `${lw}px 1fr ${rw}px` }}
    >
      {/* ── LEFT · META ──────────────────────────────────────────────── */}
      {left.collapsed ? (
        <RailStub label="META" side="left" onExpand={left.toggle} />
      ) : (
        <aside className="cl-noscroll relative overflow-auto border-r border-rule">
          <RailHeader label="META" onCollapse={left.toggle} side="left" />

          <Block label="Document">
            <KV k="ID" v={folioCode} />
            <KV
              k="Kind"
              v={
                <KindSelect
                  value={kind}
                  inferred={inferred}
                  onAssign={(k) =>
                    assign.mutate(
                      { params: { path: { path } }, body: { kind: k } },
                      { onSuccess: followMove },
                    )
                  }
                />
              }
            />
            <KV
              k="Project"
              v={
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
              }
            />
            <KV
              k="Path"
              v={<span className="break-all text-ink-mute">{path}</span>}
            />
            <KV
              k="Protection"
              v={
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
              }
            />
          </Block>

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
                      <span className="text-[9px] text-ink-mute">
                        {h.number}
                      </span>
                      <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                        {h.text}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </Block>

          <Block label="Chronology">
            <KV k="Created" v={formatAbsoluteDate(editor.createdAt)} />
            <KV k="Modified" v={formatRelativeTime(editor.updatedAt)} />
          </Block>

          <Block label="Vitals">
            <KV k="Words" v={wordCount > 0 ? wordCount : "—"} />
            <KV k="Backlinks" v={backlinks?.length ?? 0} />
            <KV k="Links" v={outlinks?.length ?? 0} />
          </Block>

          {(() => {
            const Extras = presentation.metaExtras;
            return Extras ? (
              <Block label={presentation.metaExtrasLabel ?? "Details"}>
                <Extras path={path} tabId={tabId} isDraft={editor.isDraft} />
              </Block>
            ) : null;
          })()}

          <OpenFilesAccordion activeTabId={tabId} />

          <Resizer onPointerDown={left.onResizeStart} side="right" />
        </aside>
      )}

      {/* ── CENTER · DOSSIER ─────────────────────────────────────────── */}
      <div className="relative min-h-0">
        <div
          ref={bodyRef}
          onScroll={onScroll}
          className="cl-noscroll h-full overflow-auto"
        >
          <div className="mx-auto max-w-[900px] px-7 py-[18px] pb-10">
            {/* dossier header */}
            <div className="flex items-baseline justify-between">
              <span className="cl-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute">
                FILE / {folioCode}
              </span>
              <div className="flex items-center gap-3">
                <span className="cl-mono inline-flex items-center gap-1.5 text-[9px] uppercase tracking-[0.16em] text-ink-mute">
                  <Pip kind={kind} />
                  {kindLabel(kind)}
                </span>
                <SaveIndicator
                  status={editor.saveStatus}
                  error={editor.saveError}
                  revisionConflict={editor.revisionConflict}
                  onReloadAfterConflict={editor.reloadAfterConflict}
                />
              </div>
            </div>
            <hr className="cl-rule-dash mt-2" />

            {/* title + tags + aliases */}
            <div className="mt-4">
              <PageEditorHeader
                path={path}
                title={editor.title}
                onTitleChange={editor.setTitle}
                readOnlyTitle={presentation.readOnlyTitle?.(path, editor.title)}
                tags={editableTags}
                derivedTags={isJournal ? ["journal"] : []}
                onTagsChange={editor.setTags}
                aliases={editor.aliases}
                onAliasesChange={editor.setAliases}
                onSaveNow={editor.saveNow}
                encrypted={encrypted}
                onRequestLock={encryptionActions?.lock}
              />
            </div>

            <hr className="cl-rule-dash mt-3" />

            {/* body — Slate editor styled as dossier prose */}
            <article className="codex-prose mt-5 font-sans text-[17px] leading-[1.65]">
              <WikilinkResolutionProvider path={path}>
                <SlateEditor
                  key={`${path}:${editor.editorRevision}`}
                  initialValue={editor.initialValue}
                  onChange={editor.onSlateChange}
                  onSaveNow={editor.saveNow}
                />
              </WikilinkResolutionProvider>
            </article>

            {/* end of file */}
            <hr className="cl-rule-dash mt-8" />
            <div className="cl-mono mt-1 flex justify-between text-[9px] uppercase tracking-[0.16em] text-ink-mute">
              <span>END OF FILE</span>
              <span>
                {folioCode} · {wordCount > 0 ? `${wordCount} WD` : "—"}
              </span>
            </div>
          </div>
        </div>
        <ReadingTicks toc={toc} activeIndex={activeIndex} onJump={scrollTo} />
      </div>

      {/* ── RIGHT · APPARATUS ────────────────────────────────────────── */}
      {right.collapsed ? (
        <RailStub label="LINKS" side="right" onExpand={right.toggle} />
      ) : (
        <aside className="cl-noscroll relative overflow-auto border-l border-rule">
          <Resizer onPointerDown={right.onResizeStart} side="left" />
          <div className="flex items-stretch border-b border-rule">
            <RTabBtn
              label="Backlinks"
              n={backlinks?.length ?? 0}
              active={rTab === "backlinks"}
              onClick={() => selectRTab("backlinks")}
            />
            <RTabBtn
              label="Links"
              n={outlinks?.length ?? 0}
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
            <button
              type="button"
              onClick={right.toggle}
              className="cl-mono cursor-pointer px-2 text-[12px] text-ink-mute hover:text-ink"
              aria-label="collapse panel"
            >
              ›
            </button>
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
                  items={(outlinks ?? [])
                    .filter((o): o is typeof o & { target_path: string } =>
                      Boolean(o.target_path),
                    )
                    .map((o) => ({
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
        </aside>
      )}
      {protectionDialog && editor.pageId ? (
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
      ) : null}
    </div>
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
  const activateTab = useWorkspaceStore((s) => s.activateTab);
  const togglePin = useWorkspaceStore((s) => s.togglePin);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const [open, setOpen] = useState(true);

  const pages = tabs.filter((t) => t.type === "page");
  const pinned = pages.filter((t) => t.pinned);
  const recent = pages
    .filter((t) => !t.pinned)
    .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));

  return (
    <div className="border-b border-rule-soft px-3 py-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="cl-mono mb-1.5 flex w-full cursor-pointer items-center justify-between text-[9px] uppercase tracking-[0.18em] text-ink-mute hover:text-ink"
      >
        <span>Open files · {pages.length}</span>
        <span>{open ? "⌄" : "›"}</span>
      </button>
      {open && (
        <>
          {pinned.length > 0 && (
            <Section title="Pinned">
              {pinned.map((t) => (
                <OpenRow
                  key={t.id}
                  t={t}
                  active={t.id === activeTabId}
                  onActivate={() => activateTab(t.id)}
                  onTogglePin={() => togglePin(t.id)}
                  onClose={() => closeTab(t.id)}
                />
              ))}
            </Section>
          )}
          <Section title="Recent">
            {recent.length === 0 && pinned.length === 0 ? (
              <p className="cl-marg m-0">None open.</p>
            ) : (
              recent.map((t) => (
                <OpenRow
                  key={t.id}
                  t={t}
                  active={t.id === activeTabId}
                  onActivate={() => activateTab(t.id)}
                  onTogglePin={() => togglePin(t.id)}
                  onClose={() => closeTab(t.id)}
                />
              ))
            )}
          </Section>
        </>
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
  onTogglePin,
  onClose,
}: {
  t: TabDescriptor;
  active: boolean;
  onActivate: () => void;
  onTogglePin: () => void;
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
        onClick={onTogglePin}
        aria-label={t.pinned ? "Unpin tab" : "Pin tab"}
        title={t.pinned ? "Unpin" : "Pin"}
        className={cn(
          "cl-mono flex-shrink-0 cursor-pointer px-1 text-[10px]",
          t.pinned
            ? "text-accent"
            : "text-ink-mute opacity-0 hover:text-ink group-hover:opacity-100",
        )}
      >
        ✶
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

/* ── TOC extraction from initial Slate value ──────────────────────────── */

type TocEntry = { number: string; depth: number; text: string };

interface SlateNode {
  type?: string;
  level?: number;
  children?: Array<SlateNode | { text?: string }>;
}

function buildToc(value: unknown): TocEntry[] {
  if (!Array.isArray(value)) return [];
  const counters = [0, 0, 0, 0, 0, 0];
  const out: TocEntry[] = [];
  for (const node of value as SlateNode[]) {
    if (node?.type === "heading" && typeof node.level === "number") {
      const depth = Math.max(1, Math.min(node.level, 6));
      counters[depth - 1] += 1;
      for (let i = depth; i < counters.length; i++) counters[i] = 0;
      const number = counters
        .slice(0, depth)
        .filter((n) => n > 0)
        .join(".");
      const text = nodeText(node).trim() || "(untitled)";
      out.push({ number, depth, text });
    }
  }
  return out;
}

function nodeText(node: SlateNode | { text?: string }): string {
  if ("text" in node && typeof node.text === "string") return node.text;
  if ("children" in node && Array.isArray(node.children)) {
    return node.children.map(nodeText).join("");
  }
  return "";
}
