import {
  createFileRoute,
  type SearchSchemaInput,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { Button } from "react-aria-components";
import { useFeedEntry, useFeeds } from "#/api/feeds";
import { FeedFacetSelect } from "#/components/codex/FeedFacetSelect";
import { canonicalFeedGroups } from "#/components/codex/FeedGroupComboBox";
import { FeedManagement } from "#/components/codex/FeedManagement";
import { FeedReaderPane } from "#/components/codex/FeedReaderPane";
import { FeedRiver, type FeedRiverFilters } from "#/components/codex/FeedRiver";
import { useMobileLayout } from "#/hooks/useMobileLayout";

type FeedsSearch = FeedRiverFilters & {
  manage: boolean;
  ungrouped: boolean;
  entry?: number;
};

/** A repeatable query parameter arrives as one value, a list, or not at all. */
function searchList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  return raw === undefined || raw === null || raw === "" ? [] : [raw];
}

export const Route = createFileRoute("/feeds")({
  staticData: { codexView: "feeds" },
  validateSearch: (
    search: Record<string, unknown> & SearchSchemaInput,
  ): FeedsSearch => {
    const parsedEntry =
      typeof search.entry === "number"
        ? search.entry
        : typeof search.entry === "string"
          ? Number(search.entry)
          : undefined;
    const parsedGroups = searchList(search.group).filter(
      (group) => typeof group === "string" && group !== "",
    ) as string[];
    const parsedFeeds = searchList(search.feed)
      .map((feed) => (typeof feed === "number" ? feed : Number(feed)))
      .filter((feed) => Number.isFinite(feed));
    return {
      view:
        search.view === "unread" || search.view === "saved"
          ? search.view
          : "all",
      group: parsedGroups.length > 0 ? parsedGroups : undefined,
      ungrouped: search.ungrouped === true || search.ungrouped === "true",
      feed: parsedFeeds.length > 0 ? parsedFeeds : undefined,
      tag:
        typeof search.tag === "string" && search.tag ? search.tag : undefined,
      manage: search.manage === true || search.manage === "true",
      entry:
        parsedEntry !== undefined &&
        Number.isSafeInteger(parsedEntry) &&
        parsedEntry > 0
          ? parsedEntry
          : undefined,
    };
  },
  component: FeedsPage,
});

function FeedsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/feeds" });
  const feedsQuery = useFeeds();
  const selectedEntryQuery = useFeedEntry(search.entry);
  const isMobile = useMobileLayout();
  const listRegionRef = useRef<HTMLElement>(null);
  const readerRegionRef = useRef<HTMLDivElement>(null);
  const previousEntryId = useRef<number | undefined>(undefined);
  const mobileListScrollTop = useRef(0);
  // The API reads an ungrouped feed as the empty group name; "" can never be a
  // real canonicalFeedGroups() value (it drops any group whose trimmed name is
  // empty), so it stays collision-free even against a group literally named
  // "__ungrouped__". A whitespace-only key is impossible for the same reason,
  // which is what makes it safe as the list's UNGROUPED option.
  const UNGROUPED_GROUP_FACET = "";
  const UNGROUPED_OPTION_KEY = " ";
  const selectedGroups = search.group ?? [];
  const selectedFeeds = search.feed ?? [];
  const apiGroups = search.ungrouped
    ? [...selectedGroups, UNGROUPED_GROUP_FACET]
    : selectedGroups;
  const filters: FeedRiverFilters = {
    view: search.view,
    group: apiGroups.length > 0 ? apiGroups : undefined,
    feed: selectedFeeds.length > 0 ? selectedFeeds : undefined,
    tag: search.tag,
  };
  const groups = feedsQuery.data?.groups ?? [];
  const feeds = groups.flatMap((group) => group.feeds);

  const updateSearch = (patch: Partial<FeedsSearch>, replace = false) => {
    void navigate({
      replace,
      search: (current) => ({ ...current, ...patch }),
    });
  };

  const withinGroups = (
    feedGroup: string,
    groupNames: readonly string[],
    ungrouped: boolean,
  ) => {
    if (groupNames.length === 0 && !ungrouped) return true;
    return (
      groupNames.includes(feedGroup) ||
      (ungrouped && feedGroup === UNGROUPED_GROUP_FACET)
    );
  };

  const groupOptions = [
    ...canonicalFeedGroups(groups.map((group) => group.name)).map((name) => ({
      value: name,
      label: name,
    })),
    { value: UNGROUPED_OPTION_KEY, label: "Ungrouped" },
  ];
  const groupValue = search.ungrouped
    ? [...selectedGroups, UNGROUPED_OPTION_KEY]
    : selectedGroups;
  const feedOptions = feeds
    .filter((feed) =>
      withinGroups(feed.group, selectedGroups, search.ungrouped),
    )
    .map((feed) => ({
      value: String(feed.id),
      label: feed.title_override || feed.title,
    }));
  const tagOptions = [...new Set(feeds.flatMap((feed) => feed.tags))]
    .sort()
    .map((tag) => ({ value: tag, label: tag }));

  // A reader left open on an entry the new facets exclude misreports what you
  // are looking at, so the selection closes with the filter that excluded it.
  // The view (unread/saved) is deliberately excluded: opening an unread entry
  // marks it read, and that must not close the reader under the reader.
  const selectedEntry =
    selectedEntryQuery.data?.id === search.entry
      ? selectedEntryQuery.data
      : undefined;
  const selectionSurvives = (
    groupNames: readonly string[],
    ungrouped: boolean,
    feedIds: readonly number[],
    tag?: string,
  ) => {
    // An unloaded entry cannot be judged; leave the reader as it is.
    if (!selectedEntry) return true;
    if (feedIds.length > 0 && !feedIds.includes(selectedEntry.feed_id)) {
      return false;
    }
    if (groupNames.length > 0 || ungrouped) {
      const feed = feeds.find(
        (candidate) => candidate.id === selectedEntry.feed_id,
      );
      if (feed && !withinGroups(feed.group, groupNames, ungrouped))
        return false;
    }
    return !(tag && !selectedEntry.tags.includes(tag));
  };
  const survivingEntry = (
    groupNames: readonly string[],
    ungrouped: boolean,
    feedIds: readonly number[],
    tag?: string,
  ) =>
    selectionSurvives(groupNames, ungrouped, feedIds, tag)
      ? search.entry
      : undefined;

  const hasActiveFacets =
    selectedGroups.length > 0 ||
    search.ungrouped ||
    selectedFeeds.length > 0 ||
    search.tag !== undefined;
  // Clearing only widens the river, so whatever is open still belongs in it.
  const onClearFacets = () =>
    updateSearch(
      {
        group: undefined,
        ungrouped: false,
        feed: undefined,
        tag: undefined,
      },
      true,
    );

  const onGroupsChange = (next: string[]) => {
    const nextGroups = next.filter((value) => value !== UNGROUPED_OPTION_KEY);
    const nextUngrouped = next.includes(UNGROUPED_OPTION_KEY);
    // A feed id from a group that is no longer selected would silently
    // zero-result the river, so drop the orphans and keep the rest.
    const survivingFeeds = selectedFeeds.filter((id) => {
      const feed = feeds.find((candidate) => candidate.id === id);
      return feed ? withinGroups(feed.group, nextGroups, nextUngrouped) : false;
    });
    updateSearch(
      {
        group: nextGroups.length > 0 ? nextGroups : undefined,
        ungrouped: nextUngrouped,
        feed: survivingFeeds.length > 0 ? survivingFeeds : undefined,
        entry: survivingEntry(
          nextGroups,
          nextUngrouped,
          survivingFeeds,
          search.tag,
        ),
      },
      true,
    );
  };

  useEffect(() => {
    let restoreFrame: number | undefined;
    const previous = previousEntryId.current;
    previousEntryId.current = search.entry;
    if (search.entry !== undefined && previous !== search.entry) {
      readerRegionRef.current
        ?.querySelector<HTMLElement>("[data-reader-focus]")
        ?.focus();
      return;
    }
    if (search.entry === undefined && previous !== undefined) {
      if (isMobile) {
        const main = listRegionRef.current?.closest("main");
        if (main) {
          const scrollTop = mobileListScrollTop.current;
          main.scrollTop = scrollTop;
          restoreFrame = requestAnimationFrame(() => {
            const currentList = listRegionRef.current;
            if (
              previousEntryId.current === undefined &&
              currentList?.isConnected &&
              currentList.closest("main") === main
            ) {
              main.scrollTop = scrollTop;
            }
          });
        }
      }
      const selectedRow = listRegionRef.current?.querySelector<HTMLElement>(
        `[data-feed-entry-id="${previous}"]`,
      );
      (selectedRow ?? listRegionRef.current)?.focus();
    }
    return () => {
      if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame);
    };
  }, [isMobile, search.entry]);

  return (
    <div
      data-feeds-page=""
      className="grid w-full auto-rows-min gap-3 px-2 py-2 md:h-full md:grid-rows-[auto_minmax(0,1fr)] md:contain-paint md:overflow-hidden md:px-4 md:py-3"
    >
      <section
        aria-label="Feed controls"
        className="cl-grid-texture flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border border-rule bg-paper-2 px-3 py-2 md:px-4"
      >
        <span
          aria-hidden="true"
          className="h-[7px] w-[7px] shrink-0 bg-accent"
        />
        <h1 className="font-sans text-[17px] font-black leading-none tracking-[-0.02em] text-ink">
          Feeds
        </h1>
        <span className="cl-mono hidden text-[9px] uppercase tracking-[0.24em] text-ink-mute sm:inline">
          Codex / incoming ledger
        </span>

        {search.manage ? null : (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="flex">
              <Button
                aria-pressed={search.view === "unread"}
                className={`cl-btn justify-center border-r-0 px-2 py-1 text-[9px] outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-accent ${search.view === "unread" ? "cl-btn-hot bg-highlight" : ""}`}
                onPress={() =>
                  updateSearch({
                    view: search.view === "unread" ? "all" : "unread",
                  })
                }
              >
                Hide read
              </Button>
              <Button
                aria-pressed={search.view === "saved"}
                className={`cl-btn justify-center px-2 py-1 text-[9px] outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-accent ${search.view === "saved" ? "cl-btn-hot bg-highlight" : ""}`}
                onPress={() =>
                  updateSearch({
                    view: search.view === "saved" ? "all" : "saved",
                  })
                }
              >
                Saved
              </Button>
            </div>

            <FeedFacetSelect
              multiple
              label="Group"
              options={groupOptions}
              value={groupValue}
              onChange={onGroupsChange}
            />
            <FeedFacetSelect
              multiple
              label="Feed"
              options={feedOptions}
              value={selectedFeeds.map(String)}
              onChange={(next) => {
                const nextFeeds = next.map(Number);
                updateSearch(
                  {
                    feed: nextFeeds.length > 0 ? nextFeeds : undefined,
                    entry: survivingEntry(
                      selectedGroups,
                      search.ungrouped,
                      nextFeeds,
                      search.tag,
                    ),
                  },
                  true,
                );
              }}
            />
            <FeedFacetSelect
              label="Tag"
              options={tagOptions}
              value={search.tag ? [search.tag] : []}
              onChange={(next) =>
                updateSearch(
                  {
                    tag: next[0],
                    entry: survivingEntry(
                      selectedGroups,
                      search.ungrouped,
                      selectedFeeds,
                      next[0],
                    ),
                  },
                  true,
                )
              }
            />
            {hasActiveFacets ? (
              <Button
                className="cl-btn px-2 py-1 text-[9px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
                onPress={onClearFacets}
              >
                Clear filters
              </Button>
            ) : null}
          </div>
        )}

        <Button
          className={`cl-btn ml-auto shrink-0 px-2 py-1 text-[9px] outline-none focus-visible:ring-2 focus-visible:ring-accent ${search.manage ? "cl-btn-hot" : ""}`}
          onPress={() => updateSearch({ manage: !search.manage })}
        >
          {search.manage ? "Return to river" : "Manage subscriptions"}
        </Button>
      </section>

      {search.manage ? (
        <FeedManagement />
      ) : (
        <div className="grid min-h-0 gap-3.5 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <section
            ref={listRegionRef}
            tabIndex={-1}
            aria-label="Entry list"
            hidden={isMobile && search.entry !== undefined}
            className="min-h-0 overflow-y-auto border border-rule bg-paper-2 p-3.5"
          >
            <FeedRiver
              filters={filters}
              selectedEntryId={search.entry}
              onSelectEntry={(entry) => {
                if (isMobile) {
                  mobileListScrollTop.current =
                    listRegionRef.current?.closest("main")?.scrollTop ?? 0;
                }
                updateSearch({ entry });
              }}
            />
          </section>
          <div
            ref={readerRegionRef}
            hidden={isMobile && search.entry === undefined}
            className="min-h-0 md:h-full"
          >
            <FeedReaderPane
              showBack={isMobile}
              selectedEntryId={search.entry}
              onBack={() => updateSearch({ entry: undefined })}
              onMissing={() => updateSearch({ entry: undefined }, true)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
