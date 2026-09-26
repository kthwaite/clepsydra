import { Link } from "@tanstack/react-router";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import { useState } from "react";
import type { components } from "#/api/schema";
import { IconButton } from "#/components/ui/icon-button";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { formatCapturedAt, formatDayMonthYear } from "#/lib/time";

type ArchiveMeta = components["schemas"]["ArchiveMetaResponse"];

export interface ArchiveBannerProps {
  title: string;
  path: string;
  archive: ArchiveMeta;
}

const COLLAPSE_KEY = "clepsydra.archive-banner-collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
  } catch {
    // Private-mode storage failures degrade to session-only state.
  }
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
    <div className="flex min-w-0 gap-2">
      <dt className="shrink-0 text-mute">{label}</dt>
      <dd className="m-0 min-w-0 truncate text-ink">
        {dateTime ? <time dateTime={dateTime}>{value}</time> : value}
      </dd>
    </div>
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

/** Provenance chrome for a captured page: a quiet sink strip above the
 * full-bleed snapshot, never a workspace folio or dashboard card. */
export function ArchiveBanner({ title, path, archive }: ArchiveBannerProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed);

  function toggle() {
    setCollapsed((current) => {
      const next = !current;
      writeCollapsed(next);
      return next;
    });
  }

  return (
    <header className="shrink-0 bg-sink px-6 text-ink">
      <div className="flex h-12 items-center gap-4">
        <span className="shrink-0 text-[13px] font-medium text-accent">
          Captured record
        </span>
        {collapsed ? (
          <span className="min-w-0 truncate text-[13.5px] font-medium text-ink">
            {title}
          </span>
        ) : null}
        <span className="grow" />
        <IconButton
          onPress={toggle}
          aria-expanded={!collapsed}
          aria-label={
            collapsed ? "Expand archive banner" : "Collapse archive banner"
          }
          className="h-7 w-7 shrink-0 [&_svg]:h-3.5 [&_svg]:w-3.5"
        >
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "transition-transform",
              collapsed ? undefined : "rotate-180",
            )}
          />
        </IconButton>
        <Link
          to="/pages/$"
          params={{ _splat: path }}
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-sm text-[13px] text-ink-2 hover:text-ink",
            FOCUS_RING_NATIVE,
          )}
        >
          <span aria-hidden="true">←</span>
          Back to vault page
        </Link>
      </div>

      {collapsed ? null : (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-10 pt-0.5 pb-4">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-[12.5px] text-mute">
              Archive · {archive.domain}
            </p>
            <h1 className="truncate text-[20px] font-semibold leading-tight tracking-[-0.01em] text-ink">
              {title}
            </h1>
            {isSafeLiveUrl(archive.url) ? (
              <a
                href={archive.url}
                target="_blank"
                rel="noreferrer"
                className={cn(
                  "flex min-w-0 items-center gap-1.5 rounded-sm text-[12.5px] text-accent hover:underline hover:underline-offset-4",
                  FOCUS_RING_NATIVE,
                )}
                aria-label={`Open live page: ${archive.url}`}
              >
                <span className="truncate">{archive.url}</span>
                <ArrowUpRight aria-hidden="true" className="h-3 w-3 shrink-0" />
              </a>
            ) : (
              <p className="text-[12.5px] text-hot">
                <span className="mr-2">Invalid archive URL metadata</span>
                <span className="break-all">{archive.url}</span>
              </p>
            )}
          </div>

          <dl className="m-0 grid min-w-0 grid-cols-[auto_auto] gap-x-7 gap-y-1 text-[12.5px]">
            <ProvenanceField
              label="Captured"
              value={formatCapturedAt(archive.captured_at)}
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
                value={formatDayMonthYear(archive.published_time)}
                dateTime={archive.published_time}
              />
            ) : null}
          </dl>
        </div>
      )}
    </header>
  );
}
