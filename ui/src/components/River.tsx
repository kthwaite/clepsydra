import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  type Entry,
  type EntryFilters,
  entriesQuery,
  useEntryPatch,
  useMarkAllRead,
} from "#/lib/api";
import { dayLabel, timeAgo } from "#/lib/time";

/** The feed river: unread-first incoming entries, reading in place. */
export function River({ filters }: { filters: EntryFilters }) {
  const query = useInfiniteQuery(entriesQuery(filters));
  const markAll = useMarkAllRead();
  const entries = query.data?.pages.flatMap((p) => p.entries) ?? [];

  const newest = entries[0];
  return (
    <section>
      <div className="mb-2 flex items-center justify-end gap-2">
        {filters.view === "unread" && entries.length > 0 && (
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            onClick={() =>
              markAll.mutate({
                feed_id: filters.feed,
                group: filters.group,
                before: newest ? `${newest.sort_ts}|${newest.id}` : undefined,
              })
            }
          >
            mark all read
          </button>
        )}
      </div>
      {query.isLoading && <p className="py-8 text-center text-zinc-400">loading…</p>}
      {!query.isLoading && entries.length === 0 && (
        <p className="py-8 text-center text-zinc-400">
          {filters.view === "unread" ? "nothing unread — all caught up" : "nothing here"}
        </p>
      )}
      <EntryList entries={entries} />
      <LoadMore
        hasMore={query.hasNextPage}
        loading={query.isFetchingNextPage}
        onMore={() => query.fetchNextPage()}
      />
    </section>
  );
}

function EntryList({ entries }: { entries: Entry[] }) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const patch = useEntryPatch();

  let currentDay = "";
  const rows: React.ReactNode[] = [];
  for (const e of entries) {
    const day = dayLabel(e.sort_ts);
    if (day !== currentDay) {
      currentDay = day;
      rows.push(
        <h3
          key={`day-${day}`}
          className="sticky top-0 z-10 -mx-1 bg-white/95 px-1 pt-4 pb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400 backdrop-blur dark:bg-zinc-950/95"
        >
          {day}
        </h3>,
      );
    }
    rows.push(
      <EntryRow
        key={e.id}
        entry={e}
        expanded={expandedId === e.id}
        onToggle={() => {
          const opening = expandedId !== e.id;
          setExpandedId(opening ? e.id : null);
          if (opening && !e.read) {
            patch.mutate({ id: e.id, patch: { read: true } });
          }
        }}
        onPatch={(p) => patch.mutate({ id: e.id, patch: p })}
      />,
    );
  }
  return <div>{rows}</div>;
}

function EntryRow({
  entry,
  expanded,
  onToggle,
  onPatch,
}: {
  entry: Entry;
  expanded: boolean;
  onToggle: () => void;
  onPatch: (p: { read?: boolean; bookmarked?: boolean; tags?: string[] }) => void;
}) {
  return (
    <article className="border-b border-zinc-100 dark:border-zinc-900">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-baseline gap-2 px-1 py-1.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900"
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 self-center rounded-full ${entry.read ? "bg-transparent" : "bg-sky-500"}`}
        />
        <span className="w-32 shrink-0 truncate text-xs text-zinc-400">{entry.feed_title}</span>
        <span className={`min-w-0 flex-1 truncate ${entry.read ? "text-zinc-500" : ""}`}>
          {entry.title}
        </span>
        {entry.bookmarked && <span className="shrink-0 text-xs text-amber-500">saved</span>}
        <span className="shrink-0 text-xs tabular-nums text-zinc-400">
          {timeAgo(entry.sort_ts)}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pt-1 pb-4">
          <div className="mb-2 flex items-center gap-3 text-xs text-zinc-500">
            {entry.url && (
              <a
                href={entry.url}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-zinc-300 underline-offset-2 hover:text-zinc-800 dark:hover:text-zinc-200"
              >
                open original ↗
              </a>
            )}
            {entry.author && <span>{entry.author}</span>}
            <span className="flex-1" />
            <button
              type="button"
              className="hover:text-zinc-800 dark:hover:text-zinc-200"
              onClick={() => onPatch({ bookmarked: !entry.bookmarked })}
            >
              {entry.bookmarked ? "unsave" : "save"}
            </button>
            <button
              type="button"
              className="hover:text-zinc-800 dark:hover:text-zinc-200"
              onClick={() => onPatch({ read: !entry.read })}
            >
              {entry.read ? "mark unread" : "mark read"}
            </button>
          </div>
          {entry.bookmarked && <TagEditor tags={entry.tags} onSave={(tags) => onPatch({ tags })} />}
          {entry.content_html ? (
            // Sanitized server-side at ingestion; the DB never holds raw feed HTML.
            <div
              className="entry-content max-w-prose"
              dangerouslySetInnerHTML={{ __html: entry.content_html }}
            />
          ) : (
            <p className="text-zinc-400">no content — open the original</p>
          )}
        </div>
      )}
    </article>
  );
}

function TagEditor({ tags, onSave }: { tags: string[]; onSave: (tags: string[]) => void }) {
  const [value, setValue] = useState(tags.join(", "));
  useEffect(() => setValue(tags.join(", ")), [tags]);
  const commit = () => {
    const next = value
      .split(",")
      .map((t) => t.trim().replace(/^#/, ""))
      .filter(Boolean);
    if (next.join(",") !== tags.join(",")) onSave(next);
  };
  return (
    <label className="mb-2 flex items-baseline gap-2 text-xs text-zinc-500">
      tags
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        placeholder="comma, separated"
        className="w-64 rounded border border-zinc-200 bg-transparent px-1.5 py-0.5 outline-none focus:border-zinc-400 dark:border-zinc-700 dark:focus:border-zinc-500"
      />
    </label>
  );
}

function LoadMore({
  hasMore,
  loading,
  onMore,
}: {
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasMore) return;
    const obs = new IntersectionObserver(
      (io) =>

        io.some((x) => x.isIntersecting) && !loading && onMore(),
      { rootMargin: "400px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, loading, onMore]);

  if (!hasMore) return null;
  return (
    <div ref={ref} className="py-4 text-center">
      <button
        type="button"
        onClick={onMore}
        disabled={loading}
        className="rounded px-3 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        {loading ? "loading…" : "load more"}
      </button>
    </div>
  );
}
