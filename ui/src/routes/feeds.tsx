import {
  createFileRoute,
  type SearchSchemaInput,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { Button } from "react-aria-components";
import { useFeeds } from "#/api/feeds";
import { Card } from "#/components/codex/Card";
import { canonicalFeedGroups } from "#/components/codex/FeedGroupComboBox";
import { FeedManagement } from "#/components/codex/FeedManagement";
import { FeedReaderPane } from "#/components/codex/FeedReaderPane";
import { FeedRiver, type FeedRiverFilters } from "#/components/codex/FeedRiver";
import { FilterBar } from "#/components/filters/FilterBar";
import { useMobileLayout } from "#/hooks/useMobileLayout";
import type { FilterField, FilterState } from "#/lib/filters/model";

type FeedsSearch = FeedRiverFilters & {
  manage: boolean;
  ungrouped: boolean;
  entry?: number;
};

export const Route = createFileRoute("/feeds")({
  staticData: { codexView: "feeds" },
  validateSearch: (
    search: Record<string, unknown> & SearchSchemaInput,
  ): FeedsSearch => {
    const parsedFeed =
      typeof search.feed === "number"
        ? search.feed
        : typeof search.feed === "string"
          ? Number(search.feed)
          : undefined;
    const parsedEntry =
      typeof search.entry === "number"
        ? search.entry
        : typeof search.entry === "string"
          ? Number(search.entry)
          : undefined;
    const parsedGroup =
      typeof search.group === "string" && search.group
        ? search.group
        : undefined;
    const parsedUngrouped =
      parsedGroup === undefined &&
      (search.ungrouped === true || search.ungrouped === "true");
    return {
      view:
        search.view === "unread" || search.view === "saved"
          ? search.view
          : "all",
      group: parsedGroup,
      ungrouped: parsedUngrouped,
      feed:
        parsedFeed !== undefined && Number.isFinite(parsedFeed)
          ? parsedFeed
          : undefined,
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
  const isMobile = useMobileLayout();
  const listRegionRef = useRef<HTMLElement>(null);
  const readerRegionRef = useRef<HTMLDivElement>(null);
  const previousEntryId = useRef<number | undefined>(undefined);
  const mobileListScrollTop = useRef(0);
  // "" can never be a real canonicalFeedGroups() value (it explicitly drops
  // any group whose trimmed name is empty), so it's collision-free even
  // against a real group literally named "__ungrouped__". UI-only — never
  // written to the URL; onFilterChange maps it back to ungrouped: true.
  const UNGROUPED_GROUP_FACET = "";
  const selectedGroupName = search.ungrouped
    ? UNGROUPED_GROUP_FACET
    : search.group;
  const filters: FeedRiverFilters = {
    view: search.view,
    group: selectedGroupName,
    feed: search.feed,
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

  const filterFields: FilterField[] = [
    {
      id: "group",
      kind: "single",
      label: "GROUP",
      options: [
        ...canonicalFeedGroups(groups.map((group) => group.name)).map(
          (name) => ({ value: name, label: name }),
        ),
        { value: UNGROUPED_GROUP_FACET, label: "UNGROUPED" },
      ],
    },
    {
      id: "feed",
      kind: "single",
      label: "FEED",
      options: (selectedGroupName === undefined
        ? feeds
        : feeds.filter((feed) => feed.group === selectedGroupName)
      ).map((feed) => ({
        value: String(feed.id),
        label: feed.title_override || feed.title,
      })),
    },
    {
      id: "tag",
      kind: "single",
      label: "TAG",
      options: [...new Set(feeds.flatMap((feed) => feed.tags))]
        .sort()
        .map((tag) => ({ value: tag })),
    },
  ];
  const filterState: FilterState = {
    text: "",
    facets: {
      ...(selectedGroupName !== undefined
        ? { group: [selectedGroupName] }
        : {}),
      ...(search.feed !== undefined ? { feed: [String(search.feed)] } : {}),
      ...(search.tag ? { tag: [search.tag] } : {}),
    },
  };
  const onFilterChange = (next: FilterState) => {
    const nextGroup = next.facets.group?.[0];
    navigate({
      to: "/feeds",
      replace: true,
      search: (current) => ({
        ...current,
        group: nextGroup === UNGROUPED_GROUP_FACET ? undefined : nextGroup,
        ungrouped: nextGroup === UNGROUPED_GROUP_FACET,
        feed:
          next.facets.feed?.[0] !== undefined
            ? Number(next.facets.feed[0])
            : undefined,
        tag: next.facets.tag?.[0],
      }),
    });
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
    <div className="mx-auto grid w-full max-w-[1200px] auto-rows-min gap-3.5 px-2 py-2 md:h-full md:grid-rows-[auto_auto_minmax(0,1fr)] md:contain-paint md:overflow-hidden md:px-4 md:py-4">
      <section className="cl-grid-texture border border-rule bg-paper-2 px-3 py-2.5 md:px-4 md:py-3">
        <div className="cl-mono flex flex-wrap items-center gap-2 text-[9px] uppercase tracking-[0.24em] text-ink-mute">
          <span aria-hidden="true" className="h-[7px] w-[7px] bg-accent" />
          <span>Codex / incoming ledger</span>
        </div>
        <div className="mt-1.5 flex min-w-0 flex-col justify-between gap-2 md:flex-row md:items-end">
          <div className="min-w-0">
            <h1 className="font-sans text-[clamp(26px,4vw,38px)] font-black leading-none tracking-[-0.02em] text-ink">
              Feeds
            </h1>
            <p className="cl-marg mt-1 max-w-2xl">
              A chronological river from the subscriptions maintained in
              feeds.md.
            </p>
          </div>
          <Button
            className={`cl-btn justify-center outline-none focus-visible:ring-2 focus-visible:ring-accent ${search.manage ? "cl-btn-hot" : ""}`}
            onPress={() => updateSearch({ manage: !search.manage })}
          >
            {search.manage ? "Return to river" : "Manage subscriptions"}
          </Button>
        </div>
      </section>

      {search.manage ? (
        <FeedManagement />
      ) : (
        <>
          <Card label="River controls" caption="HIDE READ · SAVED" pip="dim">
            <div className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-[auto_1fr] lg:items-end">
              <fieldset className="min-w-0 sm:col-span-2 lg:col-span-1">
                <legend className="cl-mono mb-1 text-[9px] uppercase tracking-[0.16em] text-ink-mute">
                  View
                </legend>
                <div className="grid grid-cols-2">
                  <Button
                    aria-pressed={search.view === "unread"}
                    className={`cl-btn justify-center border-r-0 px-2 outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-accent ${search.view === "unread" ? "cl-btn-hot bg-highlight" : ""}`}
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
                    className={`cl-btn justify-center px-2 outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-accent ${search.view === "saved" ? "cl-btn-hot bg-highlight" : ""}`}
                    onPress={() =>
                      updateSearch({
                        view: search.view === "saved" ? "all" : "saved",
                      })
                    }
                  >
                    Saved
                  </Button>
                </div>
              </fieldset>

              <FilterBar
                fields={filterFields}
                state={filterState}
                onChange={onFilterChange}
                showText={false}
                className="flex-wrap"
              />
            </div>
          </Card>

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
                selectedEntryId={search.entry}
                onBack={() => updateSearch({ entry: undefined })}
                onMissing={() => updateSearch({ entry: undefined }, true)}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
