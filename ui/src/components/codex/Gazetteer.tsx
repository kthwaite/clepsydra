import { useLayoutEffect, useMemo, useState } from "react";
import { formatApiError } from "#/api/error";
import { useContentIndex, useTags } from "#/api/index";
import { useAssignBulk } from "#/api/pages";
import type { BulkAssignResponse } from "#/api/types";
import { FooterControls } from "#/components/codex/FooterControls";
import { shortFolio } from "#/components/codex/folio-utils";
import { KindSelect } from "#/components/codex/KindSelect";
import { MobileGazetteer } from "#/components/codex/MobileGazetteer";
import { ProjectCombo } from "#/components/codex/ProjectCombo";
import { Tick } from "#/components/codex/Tick";
import { FilterBar } from "#/components/filters/FilterBar";
import { KindIcon } from "#/components/KindIcon";
import { Radio, RadioGroup } from "#/components/ui/radio-group";
import { Switch } from "#/components/ui/switch";
import { useElementHeight } from "#/hooks/useElementHeight";
import { useMobileLayout } from "#/hooks/useMobileLayout";
import { useOpenTab } from "#/hooks/useOpenTab";
import { useTableCompact } from "#/hooks/useTableCompact";
import { cn } from "#/lib/cn";
import type { FilterField, FilterState } from "#/lib/filters/model";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import {
  KINDS,
  type Kind,
  kindLabel,
  resolveKind,
  sortKindsByLabel,
} from "#/lib/kind";
import { formatRelativeTime } from "#/lib/time";
import { useProjects, useProjectValues } from "#/lib/useProjects";
import { useGazetteerStore } from "#/store/gazetteer";
import {
  appendUniqueTag,
  filterAndSortRows,
  type GazetteerSort,
} from "./gazetteer-filter";
import { pageItems, rangeLabel, repage, rowsThatFit } from "./gazetteer-paging";

/** Pure: returns a NEW Set with `value` toggled (added if absent, removed if present). */
export function toggleInSet<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export const MOBILE_GAZETTEER_PAGE_SIZE = 20;

const SORT_OPTIONS: Array<{ value: GazetteerSort; label: string }> = [
  { value: "ts", label: "Edited" },
  { value: "id", label: "Code" },
  { value: "title", label: "Title" },
  { value: "words", label: "Words" },
];

const fmt = (n: number) => n.toLocaleString("en-US");

const SORT_DIRECTION: Record<GazetteerSort, "ascending" | "descending"> = {
  ts: "descending",
  words: "descending",
  title: "ascending",
  id: "ascending",
};

export interface GazetteerFilters {
  filterState: FilterState;
  sort: GazetteerSort;
  page: number;
  onFilterChange: (next: FilterState) => void;
  onSortChange: (sort: GazetteerSort) => void;
  onPageChange: (page: number, replace?: boolean) => void;
}

type Props = {
  initialTag?: string;
  filters?: GazetteerFilters;
};

export function Gazetteer({ initialTag, filters }: Props) {
  const store = useGazetteerStore();
  const storeFilterState: FilterState = {
    text: store.query,
    facets: {
      ...(store.selectedTags.length ? { tags: store.selectedTags } : {}),
      ...(store.kind ? { kind: [store.kind] } : {}),
      ...(store.project ? { project: [store.project] } : {}),
    },
  };
  const storeOnFilterChange = (next: FilterState) => {
    store.setQuery(next.text);
    store.setSelectedTags(next.facets.tags ? [...next.facets.tags] : []);
    store.setKind(next.facets.kind?.[0] as Kind | undefined);
    store.setProject(next.facets.project?.[0]);
  };
  const filterState = filters?.filterState ?? storeFilterState;
  const onFilterChange = filters?.onFilterChange ?? storeOnFilterChange;
  const query = filterState.text;
  const selectedTags = [...(filterState.facets.tags ?? [])];
  const kind = filterState.facets.kind?.[0] as Kind | undefined;
  const project = filterState.facets.project?.[0];
  const sort = filters?.sort ?? store.sort;
  const page = filters?.page ?? store.page;
  const setSort = filters?.onSortChange ?? store.setSort;
  const setPage: (page: number, replace?: boolean) => void =
    filters?.onPageChange ?? store.setPage;
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [compact, setCompact] = useTableCompact("gazetteer", true);

  useLayoutEffect(() => {
    if (!filters) store.enter(initialTag);
  }, [filters, initialTag, store.enter]);

  const tagsQuery = useTags();
  const tags = tagsQuery.data ?? [];
  const requestedPage = Math.max(1, Math.floor(page));
  const isMobile = useMobileLayout();
  const [tableRef, tableHeight, remeasure] = useElementHeight<HTMLDivElement>();
  // The density the page size was sized for. Compact also resizes the
  // header, so a toggle re-measures before the page size follows it:
  // one resize, not a stale size and then the settled one.
  const [sizedCompact, setSizedCompact] = useState(compact);
  useLayoutEffect(() => {
    if (sizedCompact === compact) return;
    remeasure();
    setSizedCompact(compact);
  }, [compact, sizedCompact, remeasure]);
  const pageSize = isMobile
    ? MOBILE_GAZETTEER_PAGE_SIZE
    : rowsThatFit(tableHeight ?? 0, sizedCompact);
  // Desktop waits one layout pass for the table's height so the first fetch
  // already has the right page size.
  const measured = isMobile || tableHeight !== null;
  // The page size the URL's page was last shown at. When the size changes,
  // the page holding the same first row is shown at once — before the URL
  // catches up — so the old page is never fetched at the new size.
  const [basis, setBasis] = useState<{ size: number; page: number } | null>(
    null,
  );
  const shownPage =
    !isMobile &&
    basis !== null &&
    basis.page === requestedPage &&
    basis.size !== pageSize
      ? repage(requestedPage, basis.size, pageSize)
      : requestedPage;
  const contentQuery = useContentIndex(
    filters
      ? {
          q: query || undefined,
          tags: selectedTags.length > 0 ? selectedTags : undefined,
          kind,
          project,
          limit: pageSize,
          offset: (shownPage - 1) * pageSize,
        }
      : { kind, project, limit: 500 },
    { enabled: measured },
  );
  const { data: content } = contentQuery;
  const openTab = useOpenTab();
  const bulk = useAssignBulk();
  // Assign offers declared projects; the filter keeps orphan slugs findable.
  const projects = useProjects();
  const projectValues = useProjectValues();
  const filterFields = useMemo<FilterField[]>(
    () => [
      {
        id: "kind",
        kind: "single",
        label: "Kind",
        options: sortKindsByLabel(KINDS).map((k) => ({
          value: k,
          label: kindLabel(k),
        })),
      },
      {
        id: "project",
        kind: "single",
        label: "Project",
        options: projectValues.map((p) => ({ value: p })),
      },
      {
        id: "tags",
        kind: "multi",
        label: "Tag",
        options: tags.map((t) => ({ value: t.tag })),
      },
    ],
    [projectValues, tags],
  );

  const items = content?.items ?? [];
  const rowsForPage = useMemo(
    () =>
      filterAndSortRows(items, {
        tags: filters ? [] : [...(filterState.facets.tags ?? [])],
        query: filters ? "" : query,
        sort,
      }),
    [filters, items, query, filterState.facets.tags, sort],
  );
  const filteredCount = filters ? (content?.total ?? 0) : rowsForPage.length;
  const totalCount = filters
    ? (content?.total ?? 0)
    : Math.max(content?.total ?? 0, items.length);
  const pageCount = Math.max(1, Math.ceil(filteredCount / pageSize));
  const currentPage = contentQuery.isSuccess
    ? Math.min(shownPage, pageCount)
    : shownPage;
  const rows = useMemo(() => {
    if (filters) return rowsForPage;
    const start = (currentPage - 1) * pageSize;
    return rowsForPage.slice(start, start + pageSize);
  }, [currentPage, filters, pageSize, rowsForPage]);

  useLayoutEffect(() => {
    if (
      measured &&
      contentQuery.isSuccess &&
      !contentQuery.isPlaceholderData &&
      currentPage !== page
    )
      setPage(currentPage, true);
  }, [
    measured,
    contentQuery.isSuccess,
    contentQuery.isPlaceholderData,
    currentPage,
    page,
    setPage,
  ]);

  useLayoutEffect(() => {
    if (isMobile || !measured) return;
    if (shownPage !== requestedPage) {
      setPage(shownPage, true);
      return;
    }
    setBasis((prev) =>
      prev?.size === pageSize && prev.page === requestedPage
        ? prev
        : { size: pageSize, page: requestedPage },
    );
  }, [isMobile, measured, pageSize, requestedPage, shownPage, setPage]);
  const selected = [...selectedPaths];
  // A gap is keyed by the page before it: stable, unlike its index.
  const pageLinks = pageItems(currentPage, pageCount).map((item, i, all) => ({
    item,
    key: item === "gap" ? `gap-after-${all[i - 1]}` : `page-${item}`,
  }));

  const applyResultTag = (tag: string) => {
    const nextTags = appendUniqueTag(selectedTags, tag);
    if (nextTags !== selectedTags) {
      onFilterChange({
        ...filterState,
        facets: { ...filterState.facets, tags: nextTags },
      });
    }
  };

  const toggleRow = (path: string) => {
    setSelectedPaths((cur) => toggleInSet(cur, path));
  };

  const clearSelection = () => {
    setSelectedPaths(new Set());
  };

  const allVisibleSelected =
    rows.length > 0 && rows.every((n) => selectedPaths.has(n.path));

  const toggleAllVisible = () => {
    if (rows.length === 0) return;
    setSelectedPaths(
      allVisibleSelected ? new Set() : new Set(rows.map((n) => n.path)),
    );
  };

  const onBulkDone = (data: BulkAssignResponse) => {
    setSelectedPaths((current) => {
      const remaining = new Set(current);
      for (const [source] of data.moved) remaining.delete(source);
      for (const path of data.unchanged) remaining.delete(path);
      return remaining;
    });
  };

  const applyKind = (kind: Kind) => {
    if (bulk.isPending) return;
    bulk.mutate({ body: { paths: selected, kind } }, { onSuccess: onBulkDone });
  };
  const applyProject = (project: string) => {
    if (bulk.isPending) return;
    bulk.mutate(
      { body: { paths: selected, project } },
      { onSuccess: onBulkDone },
    );
  };
  const applyClearProject = () => {
    if (bulk.isPending) return;
    bulk.mutate(
      { body: { paths: selected, clear_project: true } },
      { onSuccess: onBulkDone },
    );
  };

  const loadError = contentQuery.error
    ? formatApiError(contentQuery.error, "Gazetteer could not be loaded.")
    : null;

  const tagSummary =
    selectedTags.length > 0
      ? ` · ${selectedTags.map((t) => `#${t}`).join(" ")}`
      : "";

  if (isMobile) {
    if (loadError) {
      return (
        <p role="alert" className="p-4 text-sm text-destructive">
          {loadError}
        </p>
      );
    }
    return (
      <MobileGazetteer
        filterState={filterState}
        onFilterChange={onFilterChange}
        filterFields={filterFields}
        sort={sort}
        rows={rows}
        totalCount={totalCount}
        filteredCount={filteredCount}
        page={currentPage}
        pageCount={pageCount}
        onSortChange={setSort}
        onPageChange={setPage}
        onOpen={(path, title) => openTab("page", path, title)}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div
        className={cn(
          "flex flex-shrink-0 flex-wrap items-end gap-x-7 gap-y-4 px-10",
          compact ? "pt-7" : "pt-10",
        )}
      >
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-2.5">
            <Tick />
            <span className="font-serif text-[19px] italic text-mute">
              Index
            </span>
          </span>
          <h1
            className={cn(
              "font-serif leading-none tracking-[-0.015em] text-ink",
              compact ? "text-[44px]" : "text-[52px]",
            )}
          >
            Gazetteer
          </h1>
        </div>
        <span className="pb-1.5 text-[14px] text-mute">
          {filteredCount === totalCount
            ? `${fmt(totalCount)} ${totalCount === 1 ? "page" : "pages"}`
            : `${fmt(filteredCount)} of ${fmt(totalCount)} pages`}
          {tagSummary}
        </span>
        <div className="flex-1" />
        <Switch isSelected={compact} onChange={setCompact}>
          Compact
        </Switch>
        <RadioGroup
          segmented
          aria-label="Sort"
          orientation="horizontal"
          value={sort}
          onChange={(value) => setSort(value as GazetteerSort)}
        >
          {SORT_OPTIONS.map((option) => (
            <Radio key={option.value} value={option.value}>
              {option.label}
            </Radio>
          ))}
        </RadioGroup>
      </div>

      <div
        className={cn(
          "flex flex-shrink-0 flex-wrap items-center gap-x-2.5 gap-y-2 px-10",
          compact ? "pt-[18px]" : "pt-6",
        )}
      >
        <FilterBar
          fields={filterFields}
          primaryFieldIds={["kind", "project", "tags"]}
          state={filterState}
          onChange={onFilterChange}
          textPlaceholder="Filter pages"
          textAriaLabel="Search pages"
          filteredCount={filteredCount}
          totalCount={totalCount}
          className="min-w-0 flex-1 flex-wrap"
        />
        {selected.length > 0 && (
          <div className="flex items-center gap-3.5 text-[13.5px]">
            <span className="font-medium text-accent">
              {selected.length} selected
            </span>
            <div className="w-[150px]">
              <KindSelect
                value={null}
                inferred={false}
                ariaLabel="Set kind for selection"
                placeholder="Set kind…"
                isDisabled={bulk.isPending}
                onAssign={applyKind}
              />
            </div>
            <div className="w-[180px]">
              <ProjectCombo
                value={null}
                options={projects}
                onAssign={applyProject}
                onClear={applyClearProject}
              />
            </div>
            <button
              type="button"
              aria-label="Clear selection"
              onClick={clearSelection}
              className={cn(
                "h-8 cursor-pointer rounded-full px-2 text-mute hover:text-ink",
                FOCUS_RING_NATIVE,
              )}
            >
              Clear
            </button>
          </div>
        )}
      </div>

      <div
        ref={tableRef}
        className={cn(
          "cl-noscroll min-h-0 flex-1 overflow-auto px-7",
          compact ? "pt-3.5" : "pt-5",
        )}
      >
        {/* Errors stay inside the screen: the header and filters remain,
            so a rejected filter can be cleared, and the table area stays
            mounted for the height that enables the query. */}
        {loadError ? (
          <p role="alert" className="px-3 py-6 text-[13.5px] text-hot">
            {loadError}
          </p>
        ) : (
          <table
            data-density={compact ? "compact" : "comfortable"}
            className="w-full table-fixed border-collapse text-left"
          >
            <thead className="sticky top-0 z-10 bg-ground">
              <tr
                className={cn(
                  "text-[12.5px] text-mute",
                  compact ? "h-[34px]" : "h-10",
                )}
              >
                <th className="w-[44px] px-3 font-normal">
                  <input
                    type="checkbox"
                    aria-label="Select all visible rows"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    disabled={rows.length === 0}
                    className="cursor-pointer accent-accent"
                  />
                </th>
                <Th w="52px">No.</Th>
                <Th
                  w="250px"
                  sorted={sort === "id" ? SORT_DIRECTION.id : undefined}
                >
                  Code
                </Th>
                <Th
                  sorted={sort === "title" ? SORT_DIRECTION.title : undefined}
                >
                  Title
                </Th>
                <Th w="210px">Tags</Th>
                <Th
                  w="76px"
                  right
                  sorted={sort === "words" ? SORT_DIRECTION.words : undefined}
                >
                  Words
                </Th>
                <Th
                  w="110px"
                  right
                  sorted={sort === "ts" ? SORT_DIRECTION.ts : undefined}
                >
                  Edited
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((n, i) => {
                const kind = resolveKind({ path: n.path, kind: n.kind });
                const isSelected = selectedPaths.has(n.path);
                const meta = compact ? "text-[12.5px]" : "text-[13px]";
                return (
                  <tr
                    key={n.path}
                    onClick={() => openTab("page", n.path, n.title || n.path)}
                    className={cn(
                      "cursor-pointer",
                      compact ? "h-8" : "h-[42px]",
                      isSelected
                        ? "[&>td]:bg-accent-tint"
                        : "hover:[&>td]:bg-sink",
                    )}
                  >
                    <td
                      className="rounded-l-[10px] px-3"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        aria-label={`Select ${n.title || n.path}`}
                        checked={isSelected}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleRow(n.path)}
                        className="cursor-pointer accent-accent"
                      />
                    </td>
                    <td className={cn("px-3 tabular-nums text-faint", meta)}>
                      {String((currentPage - 1) * pageSize + i + 1).padStart(
                        3,
                        "0",
                      )}
                    </td>
                    <td className={cn("truncate px-3 text-mute", meta)}>
                      <span className="inline-flex items-center gap-2 align-middle">
                        <KindIcon
                          kind={kind}
                          size={14}
                          className="flex-shrink-0"
                          title={kindLabel(kind)}
                        />
                        {shortFolio(n.path)}
                      </span>
                    </td>
                    <td className="truncate px-3">
                      <span
                        className={cn(
                          "text-ink",
                          compact ? "text-[13.5px]" : "text-[14.5px]",
                        )}
                      >
                        {n.title || n.path}
                      </span>
                      {n.description && (
                        <span className={cn("ml-2.5 text-mute", meta)}>
                          {n.description}
                        </span>
                      )}
                    </td>
                    <td className={cn("truncate px-3", meta)}>
                      {(n.tags ?? []).length > 0 ? (
                        <span className="flex gap-1.5 overflow-hidden whitespace-nowrap">
                          {(n.tags ?? []).map((tag) => {
                            const tagSelected = selectedTags.includes(tag);
                            return (
                              <button
                                key={tag}
                                type="button"
                                aria-label={`Filter by tag ${tag}`}
                                aria-pressed={tagSelected}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  applyResultTag(tag);
                                }}
                                className={cn(
                                  "shrink-0 rounded-sm",
                                  FOCUS_RING_NATIVE,
                                  tagSelected
                                    ? "cursor-default text-mute"
                                    : "cursor-pointer text-accent hover:text-hot",
                                )}
                              >
                                #{tag}
                              </button>
                            );
                          })}
                        </span>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td
                      className={cn(
                        "px-3 text-right tabular-nums text-mute",
                        meta,
                      )}
                    >
                      {n.word_count != null ? fmt(n.word_count) : "—"}
                    </td>
                    <td
                      className={cn(
                        "rounded-r-[10px] px-3 text-right text-mute",
                        meta,
                      )}
                    >
                      {formatRelativeTime(n.updated_at)}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-6 text-center text-[13.5px] text-mute"
                  >
                    {selectedTags.length === 0 && !query
                      ? "No pages match."
                      : `No pages${
                          selectedTags.length > 0
                            ? ` under ${selectedTags.map((t) => `#${t}`).join(" ")}`
                            : ""
                        }${query ? ` match “${query}”` : ""}.`}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <FooterControls>
        <span role="status">
          {rangeLabel(currentPage, pageSize, rows.length, filteredCount)}
        </span>
        <nav
          aria-label="Gazetteer pagination"
          className="flex items-center gap-3 text-ink"
        >
          <button
            type="button"
            aria-label="Previous page"
            disabled={currentPage <= 1}
            onClick={() => setPage(currentPage - 1)}
            className={cn(
              "cursor-pointer rounded-sm disabled:cursor-default disabled:text-faint",
              FOCUS_RING_NATIVE,
            )}
          >
            ‹
          </button>
          {pageLinks.map(({ item, key }) =>
            item === "gap" ? (
              <span key={key} aria-hidden>
                …
              </span>
            ) : (
              <button
                key={item}
                type="button"
                aria-label={`Page ${item}`}
                aria-current={item === currentPage ? "page" : undefined}
                onClick={() => setPage(item)}
                className={cn(
                  "cursor-pointer rounded-sm tabular-nums",
                  FOCUS_RING_NATIVE,
                  item === currentPage
                    ? "font-medium text-accent"
                    : "hover:text-accent",
                )}
              >
                {item}
              </button>
            ),
          )}
          <button
            type="button"
            aria-label="Next page"
            disabled={currentPage >= pageCount}
            onClick={() => setPage(currentPage + 1)}
            className={cn(
              "cursor-pointer rounded-sm disabled:cursor-default disabled:text-faint",
              FOCUS_RING_NATIVE,
            )}
          >
            ›
          </button>
        </nav>
      </FooterControls>
    </div>
  );
}

function Th({
  children,
  w,
  right,
  sorted,
}: {
  children: React.ReactNode;
  w?: string;
  right?: boolean;
  sorted?: "ascending" | "descending";
}) {
  return (
    <th
      aria-sort={sorted}
      className={cn(
        "px-3 font-normal",
        right ? "text-right" : "text-left",
        sorted && "text-ink",
      )}
      style={w ? { width: w } : undefined}
    >
      {children}
      {sorted && (
        <span aria-hidden>{sorted === "descending" ? " ↓" : " ↑"}</span>
      )}
    </th>
  );
}
