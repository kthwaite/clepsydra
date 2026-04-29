import { useEffect, useMemo, useRef, useState } from "react";
import { useBacklinks, useOutlinks, useSimilar } from "#/api/index";
import { CLink } from "#/components/codex/CLink";
import { useReadingProgress } from "#/components/codex/ReadingProgressContext";
import { formatAbsoluteDate, formatRelativeTime } from "#/components/codex/codex-time";
import { extractFootnoteDefinitions } from "#/components/codex/footnotes";
import { countWordsFromSlate, shortFolio } from "#/components/codex/folio-utils";
import { Sheaf } from "#/components/codex/Sheaf";
import { PageEditorHeader } from "#/editor/PageEditorHeader";
import { SaveIndicator } from "#/editor/SaveIndicator";
import { SlateEditor } from "#/editor/SlateEditor";
import { usePageEditor } from "#/editor/usePageEditor";
import { useWorkspaceStore } from "#/store/workspace";

type FolioProps = {
  tabId: string;
  path: string;
};

export function Folio({ tabId, path }: FolioProps) {
  const editor = usePageEditor(path);
  const { data: backlinks } = useBacklinks(path);
  const { data: outlinks } = useOutlinks(path);
  const { data: similar } = useSimilar(path);
  const updateTabLabel = useWorkspaceStore((s) => s.updateTabLabel);
  const { setProgress } = useReadingProgress();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [tocCollapsed, setTocCollapsed] = useState(false);

  useEffect(() => {
    if (editor.title) updateTabLabel(tabId, editor.title);
  }, [tabId, editor.title, updateTabLabel]);

  useEffect(() => {
    setProgress(0);
  }, [path, setProgress]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    setProgress(max > 0 ? Math.min(1, el.scrollTop / max) : 0);
  };

  const folioCode = shortFolio(path);
  const wordCount = useMemo(
    () => countWordsFromSlate(editor.initialValue),
    [editor.initialValue],
  );

  const toc = useMemo(() => buildToc(editor.initialValue), [editor.initialValue]);

  const draftedAt = useMemo(
    () => formatAbsoluteDate(editor.createdAt),
    [editor.createdAt],
  );
  const updatedAt = useMemo(
    () => formatRelativeTime(editor.updatedAt),
    [editor.updatedAt],
  );

  const footnotes = useMemo(
    () => extractFootnoteDefinitions(editor.bodyMarkdown),
    [editor.bodyMarkdown],
  );

  if (editor.isLoading) {
    return <div className="cl-marg p-6">… fetching folio {path} …</div>;
  }
  if (editor.error) {
    return <div className="cl-marg p-6">⁂ folio not found · {path}</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <Sheaf activeTabId={tabId} />

      <div
        className={`grid min-h-0 flex-1 transition-[grid-template-columns] duration-200 ${
          tocCollapsed ? "grid-cols-[34px_1fr_260px]" : "grid-cols-[200px_1fr_260px]"
        }`}
      >
        {/* L · TOC */}
        <div
          className={`cl-noscroll overflow-auto border-r border-rule ${
            tocCollapsed ? "px-1 py-3" : "px-3 py-[14px]"
          }`}
        >
          <div className="mb-1 flex items-center justify-between">
            {!tocCollapsed && <span className="cl-cap text-[9px]">§ Contents</span>}
            <button
              type="button"
              onClick={() => setTocCollapsed((c) => !c)}
              className="cl-mono cursor-pointer select-none border border-rule-soft bg-transparent px-1 text-[11px] leading-[14px] text-ink-mute"
              title={tocCollapsed ? "expand" : "collapse"}
              aria-label={tocCollapsed ? "expand contents" : "collapse contents"}
            >
              {tocCollapsed ? "›" : "‹"}
            </button>
          </div>
          {!tocCollapsed && (
            <>
              <hr className="cl-rule-soft" />
              <div className="cl-serif mt-1 text-[11px]">
                {toc.length === 0 && <p className="cl-marg m-0">No headings yet.</p>}
                {toc.map((h, i) => (
                  <div
                    key={`${h.text}-${i}`}
                    className="mb-[2px] grid grid-cols-[30px_1fr] gap-1 text-ink"
                    style={{ paddingLeft: (h.depth - 1) * 8 }}
                  >
                    <span
                      className={`cl-mono text-right text-ink-mute ${
                        h.depth > 1 ? "text-[9px]" : "text-[10px]"
                      }`}
                    >
                      {h.number}
                    </span>
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                      {h.text}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* CENTER · prose */}
        <div
          ref={bodyRef}
          onScroll={onScroll}
          className="cl-noscroll relative overflow-auto px-7 py-[14px] pb-7"
        >
          {/* page header */}
          <div className="mb-1 flex items-baseline justify-between">
            <span className="cl-cap text-[9px] text-ink-mute">{folioCode}</span>
            <div className="cl-stamp rotate-2 text-[9px]">READ · IV·xxviii</div>
            <div className="flex items-center gap-3">
              <SaveIndicator status={editor.saveStatus} error={editor.saveError} />
              <span className="cl-mono text-[9px] text-ink-mute">fol. recto</span>
            </div>
          </div>
          <hr className="cl-rule-double" />

          {/* title */}
          <div className="mt-3">
            <PageEditorHeader
              path={path}
              title={editor.title}
              onTitleChange={editor.setTitle}
              tags={editor.tags}
              onTagsChange={editor.setTags}
              aliases={editor.aliases}
              onAliasesChange={editor.setAliases}
            />
          </div>

          {/* metadata strip */}
          <div className="cl-mono mt-3 flex flex-wrap gap-x-[14px] gap-y-[2px] text-[10px] text-ink-mute">
            <span>
              {(editor.tags ?? []).map((t, i) => (
                <span key={t}>
                  {i > 0 && " · "}
                  <CLink
                    noNavigate
                    payload={{
                      title: `#${t}`,
                      folio: "Subject",
                      excerpt: `Folios under #${t}.`,
                    }}
                    className="text-accent-deep"
                  >
                    {t}
                  </CLink>
                </span>
              ))}
            </span>
            <span>
              drafted {draftedAt} · last touched {updatedAt}
            </span>
            <span>
              <em>certainty</em>: drafting · {wordCount} wd · {backlinks?.length ?? 0} backlinks
            </span>
          </div>

          {/* triplet */}
          <div className="cl-mono mb-4 mt-[6px] flex gap-[18px] border-b border-rule-soft pb-[6px] text-[10px]">
            <span className="cursor-pointer border-b border-dotted border-ink">
              ↘ backlinks · {backlinks?.length ?? 0}
            </span>
            <span style={{ borderBottom: "1px dotted var(--ink)", cursor: "pointer" }}>
              ≈ similar · {similar?.items.length ?? 0}
            </span>
            <span style={{ borderBottom: "1px dotted var(--ink)", cursor: "pointer" }}>
              ⌥ bibliography · {outlinks?.length ?? 0}
            </span>
          </div>

          {/* body — Slate editor with codex prose styling */}
          <article className="codex-prose">
            <SlateEditor
              key={`${path}:${editor.editorRevision}`}
              initialValue={editor.initialValue}
              onChange={editor.onSlateChange}
              onSaveNow={editor.saveNow}
            />
          </article>

          {/* page foot */}
          <hr className="cl-rule-soft mt-6" />
          <div className="cl-mono mt-1 flex justify-between text-[9px]">
            <span className="text-ink-mute">{path}</span>
            <span>
              fol. {folioCode} · {wordCount > 0 ? `${wordCount} wd` : "—"}
            </span>
          </div>
        </div>

        {/* R · marginalia + apparatus */}
        <div className="cl-noscroll cl-serif overflow-auto border-l border-rule px-3 py-[14px] text-[11px]">
          <div className="cl-cap mb-1 text-[9px]">↘ Backlinks · {backlinks?.length ?? 0}</div>
          <hr className="cl-rule-soft" />
          <div className="mt-1">
            {(backlinks ?? []).length === 0 && (
              <p className="cl-marg m-0">None yet — this folio stands alone.</p>
            )}
            {(backlinks ?? []).map((b) => (
              <div
                key={b.source_path}
                className="mb-[2px] grid grid-cols-[52px_1fr] text-[11px]"
              >
                <span className="cl-mono text-[9px] text-accent-deep">
                  {shortFolio(b.source_path)}
                </span>
                <CLink path={b.source_path} className="italic">
                  {b.source_title || b.source_path}
                </CLink>
              </div>
            ))}
          </div>

          <div className="cl-cap mt-4 mb-1" style={{ fontSize: 9 }}>
            § Marginalia · {footnotes.length}
          </div>
          <hr className="cl-rule-soft" />
          {footnotes.length === 0 ? (
            <p className="cl-marg mt-1" style={{ margin: 0 }}>
              No sidenotes — add <span className="cl-mono">[^1]</span> in the body and a definition
              <span className="cl-mono"> [^1]: …</span> below to populate this rail.
            </p>
          ) : (
            <ol className="cl-serif mt-1" style={{ paddingLeft: 18, margin: 0, fontSize: 11 }}>
              {footnotes.map((f, i) => (
                <li key={f.id} style={{ marginBottom: 4 }}>
                  <span className="cl-mono" style={{ color: "var(--accent-deep)", marginRight: 4 }}>
                    {i + 1}.
                  </span>
                  {f.text}
                </li>
              ))}
            </ol>
          )}

          <div className="cl-cap mb-1 mt-4 text-[9px]">⌥ Aliases</div>
          <hr className="cl-rule-soft" />
          <div className="cl-mono mt-1 text-[10px]">
            {(editor.aliases ?? []).length === 0 ? (
              <span className="cl-marg">— none —</span>
            ) : (
              editor.aliases.join(" · ")
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* --- TOC extraction from initial Slate value -------------------------------- */

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
