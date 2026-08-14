import { Link } from "@tanstack/react-router";
import type { components } from "#/api/schema";

type ArchiveMeta = components["schemas"]["ArchiveMetaResponse"];

export interface ArchiveBannerProps {
  title: string;
  path: string;
  archive: ArchiveMeta;
}

function ProvenanceField({
  label,
  value,
  dateTime,
}: {
  label: string;
  value: string;
  dateTime?: string;
}) {
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="shrink-0 text-[9px] uppercase tracking-[0.18em] text-ink-mute">
        {label}
      </span>
      {dateTime ? (
        <time dateTime={dateTime} className="truncate text-[10px] text-ink-2">
          {value}
        </time>
      ) : (
        <span className="truncate text-[10px] text-ink-2">{value}</span>
      )}
    </span>
  );
}

function isSafeLiveUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Provenance chrome for a captured page. The ruled strips deliberately echo
 * Clepsydra's dossier headers without presenting the snapshot as a workspace
 * folio or dashboard card. */
export function ArchiveBanner({ title, path, archive }: ArchiveBannerProps) {
  return (
    <header className="shrink-0 border-b border-rule bg-paper-2 text-ink">
      <div className="cl-mono flex items-center justify-between gap-4 border-b border-rule px-4 py-2">
        <span className="text-[9px] uppercase tracking-[0.22em] text-accent">
          Captured record
        </span>
        <Link
          to="/pages/$"
          params={{ _splat: path }}
          className="text-[9px] uppercase tracking-[0.16em] text-ink-mute underline decoration-rule underline-offset-4 hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-accent"
        >
          ← Back to vault page
        </Link>
      </div>

      <div className="grid gap-4 px-4 py-4 md:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)] md:items-end">
        <div className="min-w-0">
          <p className="cl-mono mb-2 text-[9px] uppercase tracking-[0.18em] text-ink-mute">
            Archive / {archive.domain}
          </p>
          <h1 className="font-sans text-xl font-black leading-tight tracking-tight text-ink md:text-2xl">
            {title}
          </h1>
          {isSafeLiveUrl(archive.url) ? (
            <a
              href={archive.url}
              target="_blank"
              rel="noreferrer"
              className="cl-mono mt-2 block truncate text-[10px] text-accent underline decoration-accent-deep underline-offset-4 hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-accent"
              aria-label={`Open live page: ${archive.url}`}
            >
              {archive.url} ↗
            </a>
          ) : (
            <p className="cl-mono mt-2 text-[10px] text-hot">
              <span className="mr-2 uppercase tracking-[0.12em]">
                Invalid archive URL metadata
              </span>
              <span className="break-all">{archive.url}</span>
            </p>
          )}
        </div>

        <div className="cl-mono grid min-w-0 gap-x-4 gap-y-2 border-l border-rule pl-4 sm:grid-cols-2">
          <ProvenanceField
            label="Captured"
            value={archive.captured_at}
            dateTime={archive.captured_at}
          />
          {archive.site_name ? (
            <ProvenanceField label="Site" value={archive.site_name} />
          ) : null}
          {archive.byline ? (
            <ProvenanceField label="Byline" value={archive.byline} />
          ) : null}
          {archive.published_time ? (
            <ProvenanceField
              label="Published"
              value={archive.published_time}
              dateTime={archive.published_time}
            />
          ) : null}
        </div>
      </div>
    </header>
  );
}
