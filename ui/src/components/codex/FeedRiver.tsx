import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "react-aria-components";
import {
  type EntryView,
  type FeedEntry,
  feedEntriesInfiniteOptions,
  useFeedEntry,
  useFeeds,
  useMarkFeedEntriesRead,
  usePatchFeedEntry,
} from "#/api/feeds";
import { cn } from "#/lib/cn";
import { feedEntryBoundary, formatFeedDay, formatFeedTime } from "#/lib/time";
import { normalizeFeedEntryTags, safeFeedEntryUrl } from "./FeedReaderPane";

/**
 * How long a row that this river just marked read stays on screen. Long enough
 * to hold its place through the click that read it, then to animate out —
 * `cl-feed-exit` in main.css holds still for the first stretch and collapses
 * over the rest, so the list never reorders under the pointer.
 */
const READ_ROW_EXIT_MS = 700;

export type FeedRiverFilters = {
  view: EntryView;
  /** Empty or absent means every group; otherwise the union of these groups. */
  group?: string[];
  /** Empty or absent means every feed; otherwise the union of these feeds. */
  feed?: number[];
  tag?: string;
};

export function FeedRiver({
  filters,
  compact = false,
  selectedEntryId,
  onSelectEntry,
}: {
  filters: FeedRiverFilters;
  compact?: boolean;
  selectedEntryId?: number;
  onSelectEntry?: (id: number) => void;
}) {
  const entriesQuery = useInfiniteQuery(feedEntriesInfiniteOptions(filters));
  const feedsQuery = useFeeds();
  const selectedEntryQuery = useFeedEntry(
    compact ? undefined : selectedEntryId,
  );
  const patchEntry = usePatchFeedEntry();
  const markEntriesRead = useMarkFeedEntriesRead();
  const [selectedEntrySnapshot, setSelectedEntrySnapshot] =
    useState<FeedEntry | null>(null);
  const [tagEditorId, setTagEditorId] = useState<number | null>(null);
  // Rows this river marked read, held by id until the query drops them so the
  // departure can be animated instead of reordering the list on the click.
  const readHere = useRef(new Map<number, FeedEntry>());
  const exitTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const [departing, setDeparting] = useState<FeedEntry[]>([]);
  const rememberRead = (entry: FeedEntry) => {
    readHere.current.set(entry.id, { ...entry, read: true });
  };
  const filterKey = [
    filters.view,
    (filters.group ?? []).join("\u0000"),
    (filters.feed ?? []).join(","),
    filters.tag ?? "",
  ].join("|");

  useEffect(() => {
    const timers = exitTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const heldFilterKey = useRef(filterKey);
  useEffect(() => {
    if (heldFilterKey.current === filterKey) return;
    heldFilterKey.current = filterKey;
    readHere.current.clear();
    for (const timer of exitTimers.current.values()) clearTimeout(timer);
    exitTimers.current.clear();
    setDeparting([]);
  }, [filterKey]);

  const entries = useMemo(
    () =>
      (entriesQuery.data?.pages.flatMap((page) => page.entries) ?? []).sort(
        byRecency,
      ),
    [entriesQuery.data],
  );
  const loadedSelectedEntry = entries.find(
    (entry) => entry.id === selectedEntryId,
  );
  useEffect(() => {
    if (selectedEntryId === undefined) {
      setSelectedEntrySnapshot(null);
      return;
    }
    if (loadedSelectedEntry) setSelectedEntrySnapshot(loadedSelectedEntry);
  }, [loadedSelectedEntry, selectedEntryId]);
  const authoritativeSelectedEntry =
    selectedEntryQuery.data?.id === selectedEntryId
      ? selectedEntryQuery.data
      : undefined;
  const activeSelectedEntry =
    selectedEntryId !== undefined
      ? (authoritativeSelectedEntry ??
        (selectedEntrySnapshot?.id === selectedEntryId
          ? selectedEntrySnapshot
          : loadedSelectedEntry))
      : undefined;
  const selectedEntries = useMemo(() => {
    if (!activeSelectedEntry) return entries;
    const mergedEntries = entries.slice();
    const selectedIndex = mergedEntries.findIndex(
      (entry) => entry.id === activeSelectedEntry.id,
    );
    if (selectedIndex === -1) mergedEntries.push(activeSelectedEntry);
    else mergedEntries[selectedIndex] = activeSelectedEntry;
    return mergedEntries.sort(byRecency);
  }, [activeSelectedEntry, entries]);
  const feedSources = useMemo(() => {
    const sources = new Map<number, { name: string; host?: string }>();
    for (const group of feedsQuery.data?.groups ?? []) {
      for (const feed of group.feeds) {
        sources.set(feed.id, {
          name: feed.title_override || feed.title,
          host: urlHost(feed.site_url ?? feed.url),
        });
      }
    }
    return sources;
  }, [feedsQuery.data]);
  const riverEntries = compact ? entries : selectedEntries;

  useEffect(() => {
    const present = new Set(riverEntries.map((entry) => entry.id));
    // A row can come back after the selection that read it finally arrives as
    // a prop: it is being read, not leaving. Cancel its exit so the animation
    // never plays on the row under the pointer.
    const returning: number[] = [];
    for (const [id, timer] of exitTimers.current) {
      if (!present.has(id)) continue;
      clearTimeout(timer);
      exitTimers.current.delete(id);
      returning.push(id);
    }
    if (returning.length > 0) {
      setDeparting((current) =>
        current.filter((entry) => !returning.includes(entry.id)),
      );
    }
    // A read row still standing only because the reader pins it earns the same
    // courtesy when the next selection releases it — however late the pin was.
    for (const entry of riverEntries) {
      if (!entry.read) continue;
      if (entries.some((loaded) => loaded.id === entry.id)) continue;
      readHere.current.set(entry.id, entry);
    }
    const leaving: FeedEntry[] = [];
    for (const [id, snapshot] of readHere.current) {
      if (present.has(id)) continue;
      readHere.current.delete(id);
      if (exitTimers.current.has(id)) continue;
      leaving.push(snapshot);
      exitTimers.current.set(
        id,
        setTimeout(() => {
          exitTimers.current.delete(id);
          setDeparting((current) => current.filter((entry) => entry.id !== id));
        }, READ_ROW_EXIT_MS),
      );
    }
    if (leaving.length > 0) {
      setDeparting((current) => [...current, ...leaving]);
    }
  }, [entries, riverEntries]);

  const visibleEntries = useMemo(() => {
    if (departing.length === 0) return riverEntries;
    const held = departing.filter(
      (entry) => !riverEntries.some((present) => present.id === entry.id),
    );
    if (held.length === 0) return riverEntries;
    return [...riverEntries, ...held].sort(byRecency);
  }, [departing, riverEntries]);
  const departingIds = new Set(departing.map((entry) => entry.id));
  const days = useMemo(() => groupByDay(visibleEntries), [visibleEntries]);

  if (entriesQuery.isPending || entriesQuery.isLoading) {
    return (
      <div
        role="status"
        aria-label="Loading feed entries"
        className="cl-mono border border-rule bg-paper-2 px-3 py-6 text-center text-[10px] uppercase tracking-[0.18em] text-ink-mute"
      >
        Loading feed entries…
      </div>
    );
  }

  return (
    <section
      aria-label="Feed river"
      className={
        compact
          ? "max-h-[36rem] overflow-y-auto"
          : "h-full min-h-0 overflow-y-auto"
      }
    >
      {!compact && feedsQuery.isError ? (
        <div
          role="alert"
          className="mb-3 border border-hot px-3 py-2 text-[12px] text-hot"
        >
          {errorMessage(
            feedsQuery.error,
            "Feed subscriptions could not be loaded. Refresh the reader to try again.",
          )}
        </div>
      ) : null}
      {entriesQuery.isError ? (
        <div
          role="alert"
          className="mb-3 border border-hot px-3 py-2 text-[12px] text-hot"
        >
          {errorMessage(
            entriesQuery.error,
            "Feed entries could not be loaded.",
          )}
        </div>
      ) : null}
      {patchEntry.error ? (
        <div
          role="alert"
          className="mb-3 border border-hot px-3 py-2 text-[12px] text-hot"
        >
          {errorMessage(
            patchEntry.error,
            "The entry change could not be saved.",
          )}
        </div>
      ) : null}
      {markEntriesRead.error ? (
        <div
          role="alert"
          className="mb-3 border border-hot px-3 py-2 text-[12px] text-hot"
        >
          {errorMessage(
            markEntriesRead.error,
            "The read boundary could not be saved.",
          )}
        </div>
      ) : null}

      {!entriesQuery.isError && visibleEntries.length === 0 ? (
        <div className="border border-dashed border-rule px-4 py-8 text-center">
          <p className="font-sans text-[14px] font-semibold text-ink">
            {emptyTitle(filters.view)}
          </p>
          <p className="cl-marg mt-1">{emptyGuidance(filters.view)}</p>
        </div>
      ) : null}

      {filters.view === "unread" && riverEntries.length > 0 ? (
        <div className="mb-3 flex justify-end">
          <Button
            className="cl-btn cl-btn-hot outline-none focus-visible:ring-2 focus-visible:ring-accent"
            isDisabled={markEntriesRead.isPending}
            onPressStart={() => markEntriesRead.reset()}
            onPress={() => {
              const newest = entries[0];
              if (!newest) return;
              // The boundary covers every loaded unread row, so hold them all
              // rather than letting the refetch clear the river in one frame.
              for (const entry of entries) {
                if (!entry.read) rememberRead(entry);
              }
              markEntriesRead.mutate({
                before: feedEntryBoundary(
                  newest.published_at ?? newest.fetched_at,
                  newest.id,
                ),
                feed: filters.feed,
                group: filters.group,
                tag: filters.tag,
              });
            }}
          >
            {markEntriesRead.isPending ? "Marking…" : "Mark all read"}
          </Button>
        </div>
      ) : null}

      <div className="space-y-5">
        {days.map(({ key, label, entries: dayEntries }) => (
          <section key={key} aria-labelledby={`feed-day-${key}`}>
            <div className="sticky top-0 z-10 mb-1.5 flex items-center gap-3 bg-paper-2 py-1">
              <h2
                id={`feed-day-${key}`}
                className="cl-mono shrink-0 text-[10px] font-medium uppercase tracking-[0.2em] text-ink-mute"
              >
                {label}
              </h2>
              <span
                aria-hidden="true"
                className="h-px min-w-0 flex-1 bg-rule"
              />
            </div>
            <div className="border-t border-rule">
              {dayEntries.map((entry) =>
                compact ? (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    feedName={feedSources.get(entry.feed_id)?.name}
                    domain={offSiteDomain(
                      entry.url,
                      feedSources.get(entry.feed_id)?.host,
                    )}
                    isDeparting={departingIds.has(entry.id)}
                    isEditingTags={tagEditorId === entry.id}
                    isPatchPending={patchEntry.isPending}
                    onOpenOriginal={() => {
                      if (entry.read) return;
                      patchEntry.reset();
                      rememberRead(entry);
                      patchEntry.mutate({ id: entry.id, read: true });
                    }}
                    onToggleRead={() => {
                      patchEntry.reset();
                      if (!entry.read) rememberRead(entry);
                      patchEntry.mutate({ id: entry.id, read: !entry.read });
                    }}
                    onToggleBookmark={() => {
                      patchEntry.reset();
                      patchEntry.mutate({
                        id: entry.id,
                        bookmarked: !entry.bookmarked,
                      });
                    }}
                    onEditTags={() => {
                      patchEntry.reset();
                      setTagEditorId(entry.id);
                    }}
                    onCancelTags={() => setTagEditorId(null)}
                    onSaveTags={async (tags) => {
                      patchEntry.reset();
                      try {
                        await patchEntry.mutateAsync({ id: entry.id, tags });
                        setTagEditorId((current) =>
                          current === entry.id ? null : current,
                        );
                      } catch {
                        // The generated mutation exposes the actionable error in-surface.
                      }
                    }}
                  />
                ) : (
                  <EntrySelectionRow
                    key={entry.id}
                    entry={entry}
                    feedName={feedSources.get(entry.feed_id)?.name}
                    domain={offSiteDomain(
                      entry.url,
                      feedSources.get(entry.feed_id)?.host,
                    )}
                    isDeparting={departingIds.has(entry.id)}
                    isSelected={selectedEntryId === entry.id}
                    onSelect={() => {
                      setSelectedEntrySnapshot(entry);
                      onSelectEntry?.(entry.id);
                      if (!entry.read) {
                        patchEntry.reset();
                        rememberRead(entry);
                        void patchEntry
                          .mutateAsync({ id: entry.id, read: true })
                          .then((updated) => {
                            if (updated?.id === entry.id) {
                              setSelectedEntrySnapshot((current) =>
                                current?.id === entry.id ? updated : current,
                              );
                            }
                          })
                          .catch(() => {
                            // The shared optimistic mutation restores the unread row on failure.
                          });
                      }
                    }}
                  />
                ),
              )}
            </div>
          </section>
        ))}
      </div>

      {compact && riverEntries.length > 0 ? (
        <a
          className="cl-btn cl-btn-hot mt-3 w-full justify-center outline-none focus-visible:ring-2 focus-visible:ring-accent"
          href={fullReaderHref(filters)}
        >
          Continue in Feeds →
        </a>
      ) : !compact && entriesQuery.hasNextPage ? (
        <Button
          className="cl-btn mt-3 w-full justify-center outline-none focus-visible:ring-2 focus-visible:ring-accent"
          isDisabled={entriesQuery.isFetchingNextPage}
          onPress={() => entriesQuery.fetchNextPage()}
        >
          {entriesQuery.isFetchingNextPage ? "Loading more…" : "Load more"}
        </Button>
      ) : null}
    </section>
  );
}

function EntrySelectionRow({
  entry,
  feedName,
  domain,
  isDeparting,
  isSelected,
  onSelect,
}: {
  entry: FeedEntry;
  feedName?: string;
  domain?: string;
  isDeparting: boolean;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const titleId = `feed-entry-title-${entry.id}`;
  return (
    <article
      aria-current={isSelected ? "true" : undefined}
      aria-labelledby={titleId}
      className={cn(
        "min-w-0 border-b border-rule",
        isSelected ? "bg-highlight" : "bg-paper-2",
        isDeparting && "cl-feed-exit",
      )}
    >
      <h3 id={titleId} className="m-0">
        <Button
          data-feed-entry-id={entry.id}
          className="group grid w-full min-w-0 grid-cols-[7px_minmax(0,1fr)_auto] items-start gap-3 px-2.5 py-3 text-left outline-none hover:bg-paper-edge focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent md:px-3.5"
          onPress={onSelect}
        >
          <span
            aria-hidden="true"
            className={`mt-1.5 h-[7px] w-[7px] ${entry.read ? "bg-ink-mute" : "bg-accent"}`}
          />
          <span className="sr-only">
            {entry.read ? "Read entry" : "Unread entry"}
          </span>
          <span className="min-w-0">
            <span className="block break-words font-sans text-[14px] font-semibold leading-[1.3] text-ink">
              {entry.title}
            </span>
            <span className="cl-mono mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-[9px] uppercase tracking-[0.12em] text-ink-mute">
              {feedName ? <span className="text-ink-2">{feedName}</span> : null}
              {domain ? <span>{domain}</span> : null}
              {entry.author ? <span>{entry.author}</span> : null}
              <time dateTime={entry.published_at ?? entry.fetched_at}>
                {formatFeedTime(entry.published_at ?? entry.fetched_at)}
              </time>
              {entry.bookmarked ? (
                <span className="text-accent">Saved</span>
              ) : null}
              {entry.tags.map((tag) => (
                <span key={tag}>#{tag}</span>
              ))}
            </span>
          </span>
          <span
            aria-hidden="true"
            className={`cl-mono mt-0.5 text-[12px] ${isSelected ? "text-accent" : "text-ink-mute"}`}
          >
            →
          </span>
        </Button>
      </h3>
    </article>
  );
}

function EntryRow({
  entry,
  feedName,
  domain,
  isDeparting,
  isEditingTags,
  isPatchPending,
  onOpenOriginal,
  onToggleRead,
  onToggleBookmark,
  onEditTags,
  onCancelTags,
  onSaveTags,
}: {
  entry: FeedEntry;
  feedName?: string;
  domain?: string;
  isDeparting: boolean;
  isEditingTags: boolean;
  isPatchPending: boolean;
  onOpenOriginal: () => void;
  onToggleRead: () => void;
  onToggleBookmark: () => void;
  onEditTags: () => void;
  onCancelTags: () => void;
  onSaveTags: (tags: string[]) => Promise<void>;
}) {
  const titleId = `feed-entry-title-${entry.id}`;
  const originalUrl = safeFeedEntryUrl(entry.url);
  return (
    <article
      aria-labelledby={titleId}
      className={cn(
        "group min-w-0 border-b border-rule bg-paper-2 hover:bg-paper-edge focus-within:bg-paper-edge",
        isDeparting && "cl-feed-exit",
      )}
    >
      <div className="grid w-full min-w-0 grid-cols-[7px_minmax(0,1fr)] items-start gap-3 px-2.5 py-3 md:grid-cols-[7px_minmax(0,1fr)_auto] md:px-3.5">
        <span
          aria-hidden="true"
          className={`mt-1.5 h-[7px] w-[7px] ${entry.read ? "bg-ink-mute" : "bg-accent"}`}
        />
        <div className="min-w-0">
          <h3
            id={titleId}
            className="m-0 break-words font-sans text-[14px] font-semibold leading-[1.3] text-ink"
          >
            <span className="sr-only">
              {entry.read ? "Read entry" : "Unread entry"}
            </span>
            {originalUrl ? (
              <a
                href={originalUrl}
                target="_blank"
                rel="noreferrer"
                onClick={onOpenOriginal}
                className="outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
              >
                {entry.title}
              </a>
            ) : (
              entry.title
            )}
          </h3>
          <span className="cl-mono mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-[9px] uppercase tracking-[0.12em] text-ink-mute">
            {feedName ? <span className="text-ink-2">{feedName}</span> : null}
            {domain ? <span>{domain}</span> : null}
            {entry.author ? <span>{entry.author}</span> : null}
            <time dateTime={entry.published_at ?? entry.fetched_at}>
              {formatFeedTime(entry.published_at ?? entry.fetched_at)}
            </time>
            {entry.bookmarked ? (
              <span className="text-accent">Saved</span>
            ) : null}
            {entry.tags.map((tag) => (
              <span key={tag}>#{tag}</span>
            ))}
          </span>
        </div>
        <div
          data-entry-actions={entry.id}
          className={cn(
            "col-start-2 row-start-2 flex shrink-0 flex-wrap items-center justify-end gap-1 transition-opacity md:col-start-3 md:row-start-1",
            isEditingTags
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100",
          )}
        >
          {originalUrl ? (
            <a
              href={originalUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open original: ${entry.title}`}
              onClick={onOpenOriginal}
              className="cl-btn cl-btn-hot px-2 py-1 text-[9px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Open ↗
            </a>
          ) : null}
          <Button
            aria-label={`Mark ${entry.title} ${entry.read ? "unread" : "read"}`}
            className="cl-btn px-2 py-1 text-[9px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
            isDisabled={isPatchPending}
            onPress={onToggleRead}
          >
            {entry.read ? "Unread" : "Read"}
          </Button>
          <Button
            aria-label={`${entry.bookmarked ? "Remove bookmark from" : "Bookmark"} ${entry.title}`}
            className="cl-btn px-2 py-1 text-[9px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
            isDisabled={isPatchPending}
            onPress={onToggleBookmark}
          >
            {entry.bookmarked ? "Unsave" : "Save"}
          </Button>
          <Button
            aria-label={`Edit tags for ${entry.title}`}
            className="cl-btn px-2 py-1 text-[9px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
            isDisabled={isPatchPending}
            onPress={onEditTags}
          >
            Tags
          </Button>
        </div>
      </div>

      {isEditingTags ? (
        <div className="border-t border-rule-soft px-2.5 pb-3 md:px-3.5">
          <TagEditor
            entry={entry}
            isPending={isPatchPending}
            onCancel={onCancelTags}
            onSave={onSaveTags}
          />
        </div>
      ) : null}
    </article>
  );
}

function TagEditor({
  entry,
  onCancel,
  isPending,
  onSave,
}: {
  entry: FeedEntry;
  isPending: boolean;
  onCancel: () => void;
  onSave: (tags: string[]) => Promise<void>;
}) {
  const [value, setValue] = useState(entry.tags.join(", "));
  return (
    <form
      className="mt-3 grid gap-2 border-l-2 border-accent pl-3 sm:grid-cols-[minmax(0,1fr)_auto]"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(normalizeFeedEntryTags(value));
      }}
    >
      <label className="cl-mono text-[9px] uppercase tracking-[0.16em] text-ink-mute">
        Tags for {entry.title}
        <input
          disabled={isPending}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="mt-1 block w-full min-w-0 border border-rule bg-paper px-2 py-1.5 text-[12px] normal-case tracking-normal text-ink outline-none focus:border-accent"
          placeholder="reading, systems"
        />
      </label>
      <div className="flex items-end gap-2">
        <Button
          type="submit"
          isDisabled={isPending}
          className="cl-btn cl-btn-hot outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {isPending ? "Saving…" : "Save tags"}
        </Button>
        <Button
          type="button"
          isDisabled={isPending}
          className="cl-btn outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onPress={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function urlHost(url: string | null | undefined) {
  const safe = safeFeedEntryUrl(url);
  if (!safe) return undefined;
  try {
    return new URL(safe).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function offSiteDomain(url: string | null | undefined, feedHost?: string) {
  const host = urlHost(url);
  return host && host !== feedHost ? host : undefined;
}

function byRecency(left: FeedEntry, right: FeedEntry) {
  const timeDifference =
    Date.parse(right.published_at ?? right.fetched_at) -
    Date.parse(left.published_at ?? left.fetched_at);
  return timeDifference || right.id - left.id;
}

function groupByDay(entries: FeedEntry[]) {
  const groups = new Map<string, FeedEntry[]>();
  for (const entry of entries) {
    const iso = entry.published_at ?? entry.fetched_at;
    const date = new Date(iso);
    const key = Number.isNaN(date.getTime())
      ? "unknown"
      : `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    const current = groups.get(key);
    if (current) current.push(entry);
    else groups.set(key, [entry]);
  }
  return [...groups.entries()].map(([key, groupedEntries]) => ({
    key,
    label: formatFeedDay(
      groupedEntries[0]?.published_at ?? groupedEntries[0]?.fetched_at,
    ),
    entries: groupedEntries,
  }));
}

function fullReaderHref(filters: FeedRiverFilters) {
  const params = new URLSearchParams({ view: filters.view });
  for (const group of filters.group ?? []) params.append("group", group);
  for (const feed of filters.feed ?? []) params.append("feed", String(feed));
  if (filters.tag) params.set("tag", filters.tag);
  return `/feeds?${params.toString()}`;
}

function emptyTitle(view: EntryView) {
  if (view === "saved") return "No saved entries";
  if (view === "unread") return "No unread entries";
  return "No feed entries";
}

function emptyGuidance(view: EntryView) {
  if (view === "saved") return "Bookmark an entry and it will remain here.";
  if (view === "unread")
    return "You are caught up. New dispatches will appear here.";
  return "Subscribe to a feed or refresh your subscriptions to begin.";
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error)
    return String(error.message);
  return fallback;
}
