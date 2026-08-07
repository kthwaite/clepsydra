import { lazy, Suspense } from "react";
import {
  countWords,
  previewMarkdownSource,
} from "#/components/codex/folio-utils";
import { kindLabel, resolveKind } from "#/lib/kind";

// react-markdown drags the whole unified/micromark pipeline (~130 kB minified)
// with it — far too heavy for the eager entry chunk when it only renders hover
// previews. Loaded on first use; the card's fill-in-as-data-arrives behaviour
// already covers the brief empty excerpt.
const PreviewMarkdown = lazy(() =>
  import("#/components/codex/PreviewMarkdown").then((m) => ({
    default: m.PreviewMarkdown,
  })),
);

// Soft fade so clipped content reads as "continues below" rather than a hard cut.
const FADE = "linear-gradient(to bottom, black 78%, transparent)";

export type PreviewBodyProps = {
  path: string;
  /** Page payload as returned by `usePage`; undefined while loading. */
  page?: {
    meta: { title?: string | null; tags?: string[] | null };
    body: string;
    encrypted?: boolean;
  };
  /** Backlink rows as returned by `useBacklinks`; undefined while loading. */
  backlinks?: unknown[];
  /** Render the tag row. The floating link window shows tags; the tab card hides them. */
  showTags?: boolean;
};

/**
 * Shared preview body for both the floating link-preview window and the Sheaf
 * tab hover card. Renders chrome immediately (kind label + path-derived title)
 * and fills excerpt / counts in as `page` data arrives.
 */
export function PreviewBody({
  path,
  page,
  backlinks,
  showTags = true,
}: PreviewBodyProps) {
  const title = page?.meta.title || path;
  const encrypted = page?.encrypted === true;
  const kind = resolveKind({ path, body: encrypted ? undefined : page?.body });
  const markdown = page && !encrypted ? previewMarkdownSource(page.body) : "";
  const words = page && !encrypted ? countWords(page.body) : 0;
  const tags = page?.meta.tags ?? [];

  return (
    <div className="px-[10px] py-2">
      <div className="mb-1 flex items-baseline justify-between border-b border-rule-soft pb-[3px]">
        <span className="cl-mono text-[9px] uppercase tracking-[0.12em] text-ink-mute">
          {kindLabel(kind)}
        </span>
        <span className="cl-mono text-[9px] text-ink-mute">
          {encrypted ? "locked" : `${words} wd`} · ↘{backlinks?.length ?? 0}
        </span>
      </div>
      <div className="mb-[3px] font-sans text-[14px] font-bold leading-[1.2]">
        {title}
      </div>
      {encrypted ? (
        <div className="cl-mono my-3 border border-rule-soft bg-paper-2 px-2 py-3 text-center text-[10px] uppercase tracking-[0.12em] text-ink-mute">
          Protected note · open to unlock
        </div>
      ) : null}
      {markdown && (
        <div
          className="max-h-[160px] overflow-hidden"
          style={{ maskImage: FADE, WebkitMaskImage: FADE }}
        >
          <Suspense fallback={null}>
            <PreviewMarkdown content={markdown} />
          </Suspense>
        </div>
      )}
      {showTags && tags.length > 0 && (
        <div className="cl-mono mt-[5px] border-t border-dotted border-rule-soft pt-1 text-[9px] text-accent">
          {tags.map((t) => `#${t}`).join(" ")}
        </div>
      )}
    </div>
  );
}
