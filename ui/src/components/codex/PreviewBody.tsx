import type { PagePreviewProjection } from "#/api/bases";
import { Fragment, lazy, Suspense } from "react";
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

const MAX_PREVIEW_VALUE_CHARACTERS = 160;
const LABEL_CONFLICT_DESCRIPTION =
  "Label conflict: matching Bases disagree, so the stored key is shown.";
const SCHEMA_CONFLICT_DESCRIPTION =
  "Schema conflict: matching Bases declare incompatible field schemas.";

function canonicalizePreviewValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizePreviewValue);
  if (typeof value !== "object" || value === null) return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalizePreviewValue(entry)]),
  );
}

function unboundedPreviewValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.map(unboundedPreviewValue).join(", ");
  }
  if (typeof value === "object") {
    return JSON.stringify(canonicalizePreviewValue(value)) ?? String(value);
  }
  return String(value);
}

function formatPreviewValue(value: unknown): string {
  const characters = Array.from(unboundedPreviewValue(value));
  if (characters.length <= MAX_PREVIEW_VALUE_CHARACTERS) {
    return characters.join("");
  }
  return `${characters.slice(0, MAX_PREVIEW_VALUE_CHARACTERS - 1).join("")}…`;
}

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
  /** Authoritative, backend-bounded Base projection for this page. */
  preview?: PagePreviewProjection;
  /** Projection fetch state. Pending is intentionally rendered without a skeleton. */
  previewPending?: boolean;
  /** Passive projection failures do not replace the existing preview content. */
  previewError?: boolean;
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
  preview,
  previewError = false,
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
      {!encrypted && previewError ? (
        <div className="cl-mono mt-[5px] border-t border-dotted border-rule-soft pt-1 text-[9px] text-ink-mute">
          Properties unavailable
        </div>
      ) : null}
      {!encrypted &&
      !previewError &&
      preview &&
      (preview.fields.length > 0 || preview.remaining_count > 0) ? (
        <dl className="cl-mono mt-[5px] grid min-w-0 grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] gap-x-2 gap-y-1 border-t border-dotted border-rule-soft pt-1 text-[9px]">
          {preview.fields.map((field) => {
            const body = field.key === "body";
            const labelClass = body
              ? "col-span-2 min-w-0 break-words text-ink-mute"
              : "min-w-0 break-words text-ink-mute";
            const valueClass = body
              ? "col-span-2 line-clamp-2 min-w-0 whitespace-normal break-words text-left text-ink-2"
              : "min-w-0 break-words text-right text-ink-2";
            return (
              <Fragment key={field.key}>
                <dt className={labelClass}>
                  {field.label}
                  {field.label_conflict ? (
                    <span
                      role="img"
                      aria-label={LABEL_CONFLICT_DESCRIPTION}
                      title={LABEL_CONFLICT_DESCRIPTION}
                      className="ml-1 font-bold text-hot"
                    >
                      !
                    </span>
                  ) : null}
                  {field.schema_conflict ? (
                    <span
                      role="img"
                      aria-label={SCHEMA_CONFLICT_DESCRIPTION}
                      title={SCHEMA_CONFLICT_DESCRIPTION}
                      className="ml-1 font-bold text-hot"
                    >
                      ≠
                    </span>
                  ) : null}
                </dt>
                <dd className={valueClass}>
                  {field.present ? formatPreviewValue(field.value) : "—"}
                </dd>
              </Fragment>
            );
          })}
          {preview.remaining_count > 0 ? (
            <>
              <dt className="sr-only">Additional projected fields</dt>
              <dd className="col-span-2 text-right text-ink-mute">
                +{preview.remaining_count} more
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {showTags && tags.length > 0 && (
        <div className="cl-mono mt-[5px] border-t border-dotted border-rule-soft pt-1 text-[9px] text-accent">
          {tags.map((t) => `#${t}`).join(" ")}
        </div>
      )}
    </div>
  );
}
