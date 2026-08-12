import { useLayoutEffect, useMemo, useState } from "react";
import {
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  Button as SelectButton,
} from "react-aria-components";
import { useContentIndex, useTags } from "#/api/index";
import { formatApiError } from "#/api/error";
import { useAssignBulk } from "#/api/pages";
import type { BulkAssignResponse } from "#/api/types";
import { shortFolio } from "#/components/codex/folio-utils";
import { MobileGazetteer } from "#/components/codex/MobileGazetteer";
import { ProjectCombo } from "#/components/codex/ProjectCombo";
import { TagInput } from "#/components/ui/tag-input";
import { useMobileLayout } from "#/hooks/useMobileLayout";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import {
  KINDS,
  type Kind,
  kindColorVar,
  kindLabel,
  resolveKind,
} from "#/lib/kind";
import { formatRelativeTime } from "#/lib/time";
import { useProjects } from "#/lib/useProjects";
import { useGazetteerStore } from "#/store/gazetteer";
import { filterAndSortRows, type GazetteerSort } from "./gazetteer-filter";

/** Pure: returns a NEW Set with `value` toggled (added if absent, removed if present). */
export function toggleInSet<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export const MOBILE_GAZETTEER_PAGE_SIZE = 20;

export interface GazetteerFilters {
  query: string;
  selectedTags: string[];
  kind?: Kind;
  queryKind?: string;
  project?: string;
  sort: GazetteerSort;
  page: number;
  onQueryChange: (query: string) => void;
  onSelectedTagsChange: (tags: string[]) => void;
  onKindChange: (kind?: Kind) => void;
  onProjectChange: (project?: string) => void;
  onSortChange: (sort: GazetteerSort) => void;
  onPageChange: (page: number) => void;
}

type Props = {
  initialTag?: string;
  filters?: GazetteerFilters;
};

export function Gazetteer({ initialTag, filters }: Props) {
  const store = useGazetteerStore();
  const query = filters?.query ?? store.query;
  const selectedTags = filters?.selectedTags ?? store.selectedTags;
  const kind = filters?.kind ?? store.kind;
  const project = filters?.project ?? store.project;
  const sort = filters?.sort ?? store.sort;
  const page = filters?.page ?? store.page;
  const setQuery = filters?.onQueryChange ?? store.setQuery;
  const setSelectedTags =
    filters?.onSelectedTagsChange ?? store.setSelectedTags;
  const setKind = filters?.onKindChange ?? store.setKind;
  const setProject = filters?.onProjectChange ?? store.setProject;
  const setSort = filters?.onSortChange ?? store.setSort;
  const setPage = filters?.onPageChange ?? store.setPage;
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  useLayoutEffect(() => {
    if (!filters) store.enter(initialTag);
  }, [filters, initialTag, store.enter]);

  const tagsQuery = useTags();
  const tags = tagsQuery.data ?? [];
  const tagSuggestions = tags.map((tag) => tag.tag);
  const requestedPage = Math.max(1, Math.floor(page));
  const contentQuery = useContentIndex(
    filters
      ? {
          q: query || undefined,
          tags: selectedTags.length > 0 ? selectedTags : undefined,
          kind: filters.queryKind ?? kind,
          project,
          limit: MOBILE_GAZETTEER_PAGE_SIZE,
          offset: (requestedPage - 1) * MOBILE_GAZETTEER_PAGE_SIZE,
        }
      : { kind, project, limit: 500 },
  );
  const { data: content } = contentQuery;
  const isMobile = useMobileLayout();
  const openTab = useOpenTab();
  const bulk = useAssignBulk();
  const projects = useProjects();

  const items = content?.items ?? [];
  const rowsForPage = useMemo(
    () =>
      filterAndSortRows(items, {
        tags: filters ? [] : selectedTags,
        query: filters ? "" : query,
        sort,
      }),
    [filters, items, query, selectedTags, sort],
  );
  const filteredCount = filters ? (content?.total ?? 0) : rowsForPage.length;
  const totalCount = filters
    ? (content?.total ?? 0)
    : Math.max(content?.total ?? 0, items.length);
  const pageCount = Math.max(
    1,
    Math.ceil(filteredCount / MOBILE_GAZETTEER_PAGE_SIZE),
  );
  const currentPage = contentQuery.isSuccess
    ? Math.min(requestedPage, pageCount)
    : requestedPage;
  const rows = useMemo(() => {
    if (filters) return rowsForPage;
    const start = (currentPage - 1) * MOBILE_GAZETTEER_PAGE_SIZE;
    return rowsForPage.slice(start, start + MOBILE_GAZETTEER_PAGE_SIZE);
  }, [currentPage, filters, rowsForPage]);

  useLayoutEffect(() => {
    if (contentQuery.isSuccess && currentPage !== page) setPage(currentPage);
  }, [contentQuery.isSuccess, currentPage, page, setPage]);
  const selected = [...selectedPaths];

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

  if (contentQuery.error) {
    return (
      <p role="alert" className="p-4 text-sm text-destructive">
        {formatApiError(contentQuery.error, "Gazetteer could not be loaded.")}
      </p>
    );
  }

  const tagSummary =
    selectedTags.length > 0
      ? ` · ${selectedTags.map((t) => `#${t}`).join(" ")}`
      : "";

  if (isMobile) {
    return (
      <MobileGazetteer
        query={query}
        selectedTags={selectedTags}
        kind={kind}
        project={project}
        projects={projects}
        sort={sort}
        rows={rows}
        tags={tags}
        tagsLoading={tagsQuery.isFetching}
        tagsError={tagsQuery.error}
        onRetryTags={() => void tagsQuery.refetch()}
        totalCount={totalCount}
        filteredCount={filteredCount}
        page={currentPage}
        pageCount={pageCount}
        onQueryChange={setQuery}
        onSelectedTagsChange={setSelectedTags}
        onKindChange={setKind}
        onProjectChange={setProject}
        onSortChange={setSort}
        onPageChange={setPage}
        onOpen={(path, title) => openTab("page", path, title)}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="flex flex-shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule px-5 py-3">
        <h1 className="font-sans text-[20px] font-black uppercase tracking-[0.04em] text-ink">
          Gazetteer<span className="text-accent"> / </span>Index
        </h1>
        <span className="cl-mono text-[10px] uppercase tracking-[0.16em] text-ink-mute">
          {filteredCount} entries{tagSummary}
        </span>
        <div className="flex-1" />
        <label className="flex items-center gap-2 border border-rule-soft px-2 py-1">
          <span className="cl-mono text-accent">/</span>
          <input
            aria-label="Search pages"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="grep…"
            className="cl-mono w-[200px] bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-mute"
          />
        </label>
        <Select
          aria-label="Filter by kind"
          selectedKey={kind ?? "all"}
          onSelectionChange={(key) =>
            setKind(key === "all" ? undefined : (key as Kind))
          }
        >
          <SelectButton className="cl-mono inline-flex cursor-pointer items-center border border-rule-soft px-2 py-1 text-[9px] uppercase tracking-[0.12em] text-ink-2 outline-none data-[hovered]:border-accent data-[focus-visible]:ring-2 data-[focus-visible]:ring-accent">
            {kind ? kindLabel(kind) : "All kinds"}
          </SelectButton>
          <Popover className="border border-rule bg-paper outline-none">
            <ListBox className="cl-mono max-h-[280px] overflow-auto p-0.5 outline-none">
              <ListBoxItem
                id="all"
                className="cursor-pointer px-2 py-1 text-[11px] uppercase tracking-[0.08em] text-ink-2 outline-none data-[focused]:bg-highlight"
              >
                All kinds
              </ListBoxItem>
              {KINDS.map((option) => (
                <ListBoxItem
                  key={option}
                  id={option}
                  className="cursor-pointer px-2 py-1 text-[11px] uppercase tracking-[0.08em] text-ink-2 outline-none data-[focused]:bg-highlight"
                >
                  {kindLabel(option)}
                </ListBoxItem>
              ))}
            </ListBox>
          </Popover>
        </Select>
        <div className="w-[180px]">
          <ProjectCombo
            value={project ?? null}
            options={projects}
            ariaLabel="Filter by project"
            menuTrigger="focus"
            onAssign={setProject}
            onClear={() => setProject(undefined)}
          />
        </div>
        <div className="cl-mono flex items-stretch border border-rule-soft text-[9px] uppercase tracking-[0.12em]">
          {(["ts", "id", "title", "words"] as GazetteerSort[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSort(s)}
              className={cn(
                "cursor-pointer border-r border-rule-soft px-2 py-1 last:border-r-0",
                sort === s
                  ? "bg-accent text-black"
                  : "text-ink-mute hover:text-ink",
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-shrink-0 items-center gap-2 border-b border-rule-soft px-5 py-2">
        <TagInput
          label="Tags"
          ariaLabel="Filter by tags"
          values={selectedTags}
          suggestions={tagSuggestions}
          suggestionsLoading={tagsQuery.isFetching}
          suggestionsError={tagsQuery.error}
          onRetrySuggestions={() => void tagsQuery.refetch()}
          allowCreate={false}
          onChange={setSelectedTags}
          placeholder="filter tags…"
          variant="codex"
          valuePrefix="#"
          maxSuggestions={8}
          className="min-w-0 flex-1"
        />
        {selectedTags.length > 0 ? (
          <button
            type="button"
            className="cl-btn"
            onClick={() => setSelectedTags([])}
          >
            clear
          </button>
        ) : null}
        <span className="cl-mono text-[9px] text-ink-mute">
          all must match · {totalCount}
        </span>
      </div>

      {/* bulk action bar — only when rows are selected */}
      {selected.length > 0 && (
        <div className="flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule bg-paper-2 px-5 py-2">
          <button
            type="button"
            onClick={clearSelection}
            className="cl-mono cursor-pointer text-[10px] uppercase tracking-[0.12em] text-ink-mute transition-colors hover:text-hot"
          >
            ✕ {selected.length} selected
          </button>
          <span className="cl-mono text-[9px] uppercase tracking-[0.12em] text-ink-mute">
            ↦ assign
          </span>
          <Select
            aria-label="Set kind for selection"
            isDisabled={bulk.isPending}
            onSelectionChange={(k) => k && applyKind(k as Kind)}
          >
            <SelectButton
              className={cn(
                "cl-mono inline-flex cursor-pointer items-center gap-1.5 border border-rule px-1.5 py-[2px] text-[11px] uppercase tracking-[0.08em] text-ink-2 outline-none transition-colors",
                "data-[hovered]:border-accent data-[hovered]:text-ink",
                "data-[focus-visible]:outline data-[focus-visible]:outline-1 data-[focus-visible]:outline-accent",
                "data-[disabled]:cursor-default data-[disabled]:text-ink-mute",
              )}
            >
              Set kind…
            </SelectButton>
            <Popover className="border border-rule bg-paper outline-none">
              <ListBox className="cl-mono max-h-[280px] overflow-auto p-0.5 outline-none">
                {KINDS.map((k) => (
                  <ListBoxItem
                    key={k}
                    id={k}
                    className={cn(
                      "cursor-pointer px-2 py-1 text-[11px] uppercase tracking-[0.08em] text-ink-2 outline-none",
                      "data-[hovered]:bg-highlight data-[hovered]:text-ink",
                      "data-[focused]:bg-highlight data-[focused]:text-ink",
                    )}
                  >
                    {kindLabel(k)}
                  </ListBoxItem>
                ))}
              </ListBox>
            </Popover>
          </Select>
          <div className="w-[180px]">
            <ProjectCombo
              value={null}
              options={projects}
              onAssign={applyProject}
              onClear={applyClearProject}
            />
          </div>
        </div>
      )}

      {/* table */}
      <div className="cl-noscroll min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-paper">
            <tr className="cl-mono border-b border-rule text-[9px] uppercase tracking-[0.14em] text-ink-mute">
              <th className="w-[36px] px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="Select all visible rows"
                  checked={allVisibleSelected}
                  onChange={toggleAllVisible}
                  disabled={rows.length === 0}
                  className="cursor-pointer accent-accent"
                />
              </th>
              <Th w="48px">№</Th>
              <Th w="150px">File-ID</Th>
              <Th>Title · excerpt</Th>
              <Th w="200px">Tags</Th>
              <Th w="64px" right>
                Words
              </Th>
              <Th w="110px" right>
                Edited
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((n, i) => {
              const kind = resolveKind({ path: n.path, kind: n.kind });
              return (
                <tr
                  key={n.path}
                  onClick={() => openTab("page", n.path, n.title || n.path)}
                  className="cursor-pointer border-b border-dotted border-rule-soft align-baseline hover:bg-paper-2"
                >
                  <td
                    className="px-3 py-1.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Select ${n.title || n.path}`}
                      checked={selectedPaths.has(n.path)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleRow(n.path)}
                      className="cursor-pointer accent-accent"
                    />
                  </td>
                  <td className="cl-mono px-3 py-1.5 text-[10px] tabular-nums text-ink-mute">
                    {String(
                      (currentPage - 1) * MOBILE_GAZETTEER_PAGE_SIZE + i + 1,
                    ).padStart(3, "0")}
                  </td>
                  <td className="cl-mono px-3 py-1.5">
                    <span className="flex items-center gap-1.5">
                      <span
                        className="inline-block h-[6px] w-[6px] flex-shrink-0"
                        style={{ background: kindColorVar(kind) }}
                        title={kindLabel(kind)}
                      />
                      <span className="text-[10px] text-ink-2">
                        {shortFolio(n.path)}
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="font-sans text-[13px] text-ink">
                      {n.title || n.path}
                    </span>
                    {n.description && (
                      <span className="cl-mono ml-2 text-[10px] text-ink-mute">
                        {n.description.slice(0, 80)}
                        {n.description.length > 80 ? "…" : ""}
                      </span>
                    )}
                  </td>
                  <td className="cl-mono px-3 py-1.5 text-[9px] text-accent">
                    <span className="block overflow-hidden text-ellipsis whitespace-nowrap">
                      {(n.tags ?? []).map((t) => `#${t}`).join(" ") || "—"}
                    </span>
                  </td>
                  <td className="cl-mono px-3 py-1.5 text-right text-[10px] tabular-nums text-ink-mute">
                    {n.word_count ?? "—"}
                  </td>
                  <td className="cl-mono px-3 py-1.5 text-right text-[10px] text-ink-mute">
                    {formatRelativeTime(n.updated_at)}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="cl-marg px-3 py-6 text-center">
                  ∅ no folios
                  {selectedTags.length > 0
                    ? ` under ${selectedTags.map((t) => `#${t}`).join(" ")}`
                    : ""}
                  {query ? ` matching “${query}”` : ""}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <nav
        aria-label="Gazetteer pagination"
        className="cl-mono flex shrink-0 items-center justify-end gap-3 border-t border-rule px-5 py-2 text-[10px] uppercase tracking-[0.1em] text-ink-mute"
      >
        <button
          type="button"
          aria-label="Previous page"
          disabled={currentPage <= 1}
          onClick={() => setPage(currentPage - 1)}
          className="cursor-pointer disabled:cursor-default disabled:opacity-40"
        >
          Previous
        </button>
        <span role="status">
          Page {currentPage} of {pageCount} · {filteredCount}{" "}
          {filteredCount === 1 ? "match" : "matches"}
        </span>
        <button
          type="button"
          aria-label="Next page"
          disabled={currentPage >= pageCount}
          onClick={() => setPage(currentPage + 1)}
          className="cursor-pointer disabled:cursor-default disabled:opacity-40"
        >
          Next
        </button>
      </nav>
    </div>
  );
}

function Th({
  children,
  w,
  right,
}: {
  children: React.ReactNode;
  w?: string;
  right?: boolean;
}) {
  return (
    <th
      className={cn(
        "px-3 py-2 font-medium",
        right ? "text-right" : "text-left",
      )}
      style={w ? { width: w } : undefined}
    >
      {children}
    </th>
  );
}
