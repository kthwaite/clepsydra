import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button, Disclosure, DisclosurePanel } from "react-aria-components";
import {
  type EntryView,
  type FeedEntry,
  feedEntriesInfiniteOptions,
  useFeeds,
  useMarkFeedEntriesRead,
  usePatchFeedEntry,
} from "#/api/feeds";
import { feedEntryBoundary, formatFeedDay, formatFeedTime } from "#/lib/time";

export type FeedRiverFilters = {
  view: EntryView;
  group?: string;
  feed?: number;
  tag?: string;
};

export function FeedRiver({
  filters,
  compact = false,
}: {
  filters: FeedRiverFilters;
  compact?: boolean;
}) {
  const entriesQuery = useInfiniteQuery(feedEntriesInfiniteOptions(filters));
  const feedsQuery = useFeeds();
  const patchEntry = usePatchFeedEntry();
  const markEntriesRead = useMarkFeedEntriesRead();
  const [expandedEntry, setExpandedEntry] = useState<FeedEntry | null>(null);
  const [tagEditorId, setTagEditorId] = useState<number | null>(null);

  const entries = useMemo(
    () =>
      (entriesQuery.data?.pages.flatMap((page) => page.entries) ?? []).sort(
        (left, right) => {
          const timeDifference =
            Date.parse(right.published_at ?? right.fetched_at) -
            Date.parse(left.published_at ?? left.fetched_at);
          return timeDifference || right.id - left.id;
        },
      ),
    [entriesQuery.data],
  );
  const visibleEntries = useMemo(() => {
    if (
      !expandedEntry ||
      entries.some((entry) => entry.id === expandedEntry.id)
    ) {
      return entries;
    }
    return [...entries, expandedEntry].sort((left, right) => {
      const timeDifference =
        Date.parse(right.published_at ?? right.fetched_at) -
        Date.parse(left.published_at ?? left.fetched_at);
      return timeDifference || right.id - left.id;
    });
  }, [entries, expandedEntry]);
  const feedNames = useMemo(() => {
    const names = new Map<number, string>();
    for (const group of feedsQuery.data?.groups ?? []) {
      for (const feed of group.feeds)
        names.set(feed.id, feed.title_override || feed.title);
    }
    return names;
  }, [feedsQuery.data]);
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
      className={compact ? "max-h-[36rem] overflow-y-auto" : undefined}
    >
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

      {filters.view === "unread" && visibleEntries.length > 0 ? (
        <div className="mb-3 flex justify-end">
          <Button
            className="cl-btn cl-btn-hot outline-none focus-visible:ring-2 focus-visible:ring-accent"
            isDisabled={markEntriesRead.isPending}
            onPressStart={() => markEntriesRead.reset()}
            onPress={() => {
              const newest = entries[0];
              if (!newest) return;
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
            <div className="mb-1.5 flex items-center gap-3">
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
              {dayEntries.map((entry) => {
                const isExpanded = expandedEntry?.id === entry.id;
                return (
                  <EntryDisclosure
                    key={entry.id}
                    entry={entry}
                    feedName={feedNames.get(entry.feed_id)}
                    isExpanded={isExpanded}
                    isEditingTags={tagEditorId === entry.id}
                    isPatchPending={patchEntry.isPending}
                    onExpandedChange={(expanded) => {
                      setExpandedEntry(expanded ? entry : null);
                      setTagEditorId(null);
                      if (expanded && !entry.read) {
                        patchEntry.reset();
                        patchEntry.mutate({ id: entry.id, read: true });
                      }
                    }}
                    onToggleBookmark={() => {
                      patchEntry.reset();
                      patchEntry.mutate({
                        id: entry.id,
                        bookmarked: !entry.bookmarked,
                      });
                    }}
                    onToggleRead={() => {
                      patchEntry.reset();
                      patchEntry.mutate({ id: entry.id, read: !entry.read });
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
                        setTagEditorId(null);
                      } catch {
                        // The generated mutation exposes the actionable error in-surface.
                      }
                    }}
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>

      {compact && visibleEntries.length > 0 ? (
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

function EntryDisclosure({
  entry,
  feedName,
  isExpanded,
  isEditingTags,
  isPatchPending,
  onExpandedChange,
  onToggleBookmark,
  onToggleRead,
  onEditTags,
  onCancelTags,
  onSaveTags,
}: {
  entry: FeedEntry;
  feedName?: string;
  isExpanded: boolean;
  isEditingTags: boolean;
  isPatchPending: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onToggleBookmark: () => void;
  onToggleRead: () => void;
  onEditTags: () => void;
  onCancelTags: () => void;
  onSaveTags: (tags: string[]) => Promise<void>;
}) {
  const titleId = `feed-entry-title-${entry.id}`;
  const originalUrl = safeHostedUrl(entry.url);
  return (
    <article
      aria-labelledby={titleId}
      className="min-w-0 border-b border-rule bg-paper-2"
    >
      <Disclosure isExpanded={isExpanded} onExpandedChange={onExpandedChange}>
        <h3 id={titleId} className="m-0">
          <Button
            slot="trigger"
            className="group grid w-full min-w-0 grid-cols-[7px_minmax(0,1fr)_auto] items-start gap-3 px-2.5 py-3 text-left outline-none hover:bg-paper-edge focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent md:px-3.5"
          >
            <span
              aria-hidden="true"
              className={`mt-1.5 h-[7px] w-[7px] ${entry.read ? "bg-ink-mute" : "bg-accent"}`}
            />
            <span className="min-w-0">
              <span className="block break-words font-sans text-[14px] font-semibold leading-[1.3] text-ink">
                {entry.title}
              </span>
              <span className="cl-mono mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-[9px] uppercase tracking-[0.12em] text-ink-mute">
                {feedName ? (
                  <span className="text-ink-2">{feedName}</span>
                ) : null}
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
              className="cl-mono mt-0.5 text-[12px] text-ink-mute"
            >
              {isExpanded ? "−" : "+"}
            </span>
          </Button>
        </h3>
        {isExpanded ? (
          <DisclosurePanel className="overflow-hidden">
            <div className="border-t border-rule-soft px-3 py-3 md:px-6 md:py-4">
              {entry.content_html ? (
                <div
                  className="feed-entry-content"
                  dangerouslySetInnerHTML={{ __html: entry.content_html }}
                />
              ) : (
                <p className="cl-marg">
                  This entry has no stored body. Open the original to continue
                  reading.
                </p>
              )}

              <div className="mt-4 flex min-w-0 flex-wrap items-center gap-2 border-t border-rule-soft pt-3">
                {originalUrl ? (
                  <a
                    href={originalUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="cl-btn cl-btn-hot outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    Open original ↗
                  </a>
                ) : null}
                <Button
                  className="cl-btn outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  isDisabled={isPatchPending}
                  onPress={onToggleRead}
                >
                  {entry.read ? "Mark unread" : "Mark read"}
                </Button>
                <Button
                  aria-label={`${entry.bookmarked ? "Remove bookmark from" : "Bookmark"} ${entry.title}`}
                  className="cl-btn outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  isDisabled={isPatchPending}
                  onPress={onToggleBookmark}
                >
                  {entry.bookmarked ? "Unsave" : "Bookmark"}
                </Button>
                <Button
                  className="cl-btn outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  isDisabled={isPatchPending}
                  onPress={onEditTags}
                >
                  Edit tags
                </Button>
              </div>

              {isEditingTags ? (
                <TagEditor
                  entry={entry}
                  isPending={isPatchPending}
                  onCancel={onCancelTags}
                  onSave={onSaveTags}
                />
              ) : null}
            </div>
          </DisclosurePanel>
        ) : null}
      </Disclosure>
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
        void onSave(normalizeTags(value));
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

function safeHostedUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function normalizeTags(value: string) {
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim().replace(/^#+/, ""))
        .filter(Boolean),
    ),
  ];
}

function fullReaderHref(filters: FeedRiverFilters) {
  const params = new URLSearchParams({ view: filters.view });
  if (filters.group) params.set("group", filters.group);
  if (filters.feed !== undefined) params.set("feed", String(filters.feed));
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
