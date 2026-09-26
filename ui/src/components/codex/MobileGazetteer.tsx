import { SlidersHorizontal } from "lucide-react";
import { useId, useState } from "react";
import {
  Button as AriaButton,
  Dialog,
  Heading,
  Modal,
  ModalOverlay,
} from "react-aria-components";
import type { ContentEntry } from "#/api/types";
import { Tick } from "#/components/codex/Tick";
import { FilterBar } from "#/components/filters/FilterBar";
import { KindIcon } from "#/components/KindIcon";
import { Button } from "#/components/ui/button";
import { Radio, RadioGroup } from "#/components/ui/radio-group";
import { cn } from "#/lib/cn";
import {
  activeFacets,
  type FilterField,
  type FilterState,
} from "#/lib/filters/model";
import { FOCUS_RING } from "#/lib/focusRing";
import { kindDisplayLabel, resolveKind } from "#/lib/kind";
import { formatDayMonthYear, formatRelativeTime } from "#/lib/time";
import { appendUniqueTag, type GazetteerSort } from "./gazetteer-filter";

export interface MobileGazetteerProps {
  filterState: FilterState;
  onFilterChange: (next: FilterState) => void;
  filterFields: readonly FilterField[];
  sort: GazetteerSort;
  rows: ContentEntry[];
  totalCount: number;
  filteredCount: number;
  page: number;
  pageCount: number;
  onSortChange: (sort: GazetteerSort) => void;
  onPageChange: (page: number) => void;
  onOpen: (path: string, title: string) => void;
}

const sortOptions: { value: GazetteerSort; label: string }[] = [
  { value: "ts", label: "Edited" },
  { value: "id", label: "File ID" },
  { value: "title", label: "Title" },
  { value: "words", label: "Words" },
];

const fmt = (n: number) => n.toLocaleString("en-US");

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Recent edits read relative ("3h ago"); anything older than a week gets
 *  a calendar day with a fixed month name ("15 Jan 2020"). */
function editedLabel(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (iso && !Number.isNaN(t) && Date.now() - t >= WEEK_MS) {
    return formatDayMonthYear(iso);
  }
  return formatRelativeTime(iso);
}

export function MobileGazetteer({
  filterState,
  onFilterChange,
  filterFields,
  sort,
  rows,
  totalCount,
  filteredCount,
  page,
  pageCount,
  onSortChange,
  onPageChange,
  onOpen,
}: MobileGazetteerProps) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const sortHeadingId = useId();
  const selectedTags = [...(filterState.facets.tags ?? [])];

  const activeFilterCount =
    activeFacets(filterState).reduce(
      (sum, [, values]) => sum + values.length,
      0,
    ) + (filterState.text ? 1 : 0);

  const applyResultTag = (tag: string) => {
    const nextTags = appendUniqueTag(selectedTags, tag);
    if (nextTags !== selectedTags) {
      onFilterChange({
        ...filterState,
        facets: { ...filterState.facets, tags: nextTags },
      });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-ground text-ink">
      <header className="flex shrink-0 items-end gap-3 px-5 pt-1.5">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="flex items-center gap-2.5">
            <Tick />
            <span className="truncate font-serif text-[18px] italic text-mute">
              Index · {fmt(filteredCount)} of {fmt(totalCount)}
            </span>
          </span>
          <h1 className="font-serif text-[44px] leading-none tracking-[-0.015em] text-ink">
            Gazetteer
          </h1>
        </div>
        <AriaButton
          aria-haspopup="dialog"
          className={cn(
            "inline-flex h-11 shrink-0 cursor-pointer items-center gap-2 rounded-full bg-accent-tint px-4 text-[14px] font-medium text-accent transition-colors data-[hovered]:bg-accent/15",
            FOCUS_RING,
          )}
          onPress={() => setFiltersOpen(true)}
        >
          <SlidersHorizontal aria-hidden className="h-[15px] w-[15px]" />
          Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}
        </AriaButton>
      </header>

      <div className="cl-noscroll min-h-0 flex-1 overflow-y-auto px-4 pt-[18px] pb-3">
        {rows.length > 0 ? (
          <ul aria-label="Vault pages" className="flex flex-col gap-2.5 p-0">
            {rows.map((row) => {
              const title = row.title || row.path;
              const kind = resolveKind({ path: row.path, kind: row.kind });
              const wordCount = row.word_count;

              return (
                <li
                  key={row.path}
                  className="rounded-2xl bg-raise py-3.5 pr-3.5 pl-[18px]"
                >
                  <article className="flex flex-col gap-2.5">
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                      <div className="flex min-w-0 flex-col gap-1">
                        <h2 className="font-serif text-[20px] leading-[1.2] text-ink">
                          {title}
                        </h2>
                        <p className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-mute">
                          <KindIcon
                            kind={kind}
                            size={13}
                            className="shrink-0"
                          />
                          <span className="shrink-0">
                            {kindDisplayLabel(kind)}
                          </span>
                          <span aria-hidden="true" className="text-faint">
                            ·
                          </span>
                          <span className="truncate">
                            {row.project || "No project"}
                          </span>
                        </p>
                        <p className="break-all text-[12.5px] text-mute">
                          {row.path}
                        </p>
                      </div>
                      <Button
                        aria-label={`Open ${title}`}
                        className="h-11 rounded-full"
                        onPress={() => onOpen(row.path, title)}
                      >
                        Open
                      </Button>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      {row.tags.length > 0 ? (
                        row.tags.map((tag) => {
                          const isSelected = selectedTags.includes(tag);
                          return (
                            <AriaButton
                              key={tag}
                              aria-label={`Filter by tag ${tag}`}
                              aria-pressed={isSelected}
                              onPress={() => applyResultTag(tag)}
                              className={cn(
                                "inline-flex h-8 items-center rounded-full px-3 text-[13px] transition-colors",
                                FOCUS_RING,
                                isSelected
                                  ? "cursor-default bg-accent-tint text-mute"
                                  : "cursor-pointer bg-sink text-accent data-[hovered]:bg-accent-tint",
                              )}
                            >
                              #{tag}
                            </AriaButton>
                          );
                        })
                      ) : (
                        <span className="text-[12.5px] text-mute">No tags</span>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-3 text-[12.5px] text-mute tabular-nums">
                      <span>
                        {wordCount == null
                          ? "Words unavailable"
                          : `${fmt(wordCount)} ${wordCount === 1 ? "word" : "words"}`}
                      </span>
                      <span>Edited {editedLabel(row.updated_at)}</span>
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="px-6 py-12 text-center">
            <p className="font-serif text-[22px] italic text-mute">
              No pages match these filters.
            </p>
            <p className="mt-2 text-[13px] text-mute">
              Adjust the search or selected tags in Filters.
            </p>
          </div>
        )}
      </div>

      <nav
        aria-label="Gazetteer pagination"
        className="flex shrink-0 items-center gap-2 bg-ground px-4 py-2.5"
      >
        <Button
          aria-label="Previous page"
          className="h-11 min-h-11 min-w-11 rounded-full"
          isDisabled={page <= 1}
          onPress={() => onPageChange(page - 1)}
        >
          Previous
        </Button>
        <span
          role="status"
          aria-live="polite"
          className="min-w-0 flex-1 text-center text-[13px] text-mute tabular-nums"
        >
          Page {page} of {pageCount} · {fmt(filteredCount)}{" "}
          {filteredCount === 1 ? "match" : "matches"}
        </span>
        <Button
          aria-label="Next page"
          className="h-11 min-h-11 min-w-11 rounded-full"
          isDisabled={page >= pageCount}
          onPress={() => onPageChange(page + 1)}
        >
          Next
        </Button>
      </nav>

      <ModalOverlay
        isOpen={filtersOpen}
        isDismissable
        onOpenChange={setFiltersOpen}
        className="fixed inset-0 z-50 flex items-end bg-scrim"
      >
        <Modal className="max-h-[85dvh] w-full rounded-t-[24px] bg-raise shadow-xl outline-none">
          <Dialog
            aria-label="Gazetteer filters"
            className="flex max-h-[85dvh] min-h-0 flex-col outline-none [&_button]:min-h-11 [&_input]:min-h-11 [&_[role=option]]:min-h-11"
          >
            <span
              aria-hidden="true"
              className="mx-auto mt-2.5 h-[5px] w-10 shrink-0 rounded-full bg-sink"
            />
            <div className="flex shrink-0 items-center gap-3 px-5 pt-4">
              <Heading
                slot="title"
                className="min-w-0 flex-1 font-serif text-[28px] leading-none text-ink"
              >
                Gazetteer filters
              </Heading>
              <Button
                aria-label="Close filters"
                className="h-11 rounded-full"
                onPress={() => setFiltersOpen(false)}
              >
                Close
              </Button>
            </div>

            <div className="cl-noscroll flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pt-5 pb-[max(2rem,env(safe-area-inset-bottom))]">
              <section className="flex flex-col gap-3">
                <div className="flex items-center gap-2.5">
                  <Tick />
                  <h2 className="font-serif text-[18px] italic leading-none text-mute">
                    Filter by
                  </h2>
                </div>
                <div className="pl-[17px]">
                  <FilterBar
                    fields={filterFields}
                    primaryFieldIds={["kind", "project", "tags"]}
                    state={filterState}
                    onChange={onFilterChange}
                    textPlaceholder="Title, path, description, or tag"
                    textAriaLabel="Search pages"
                    className="flex-wrap"
                    optionClassName="min-h-11"
                  />
                </div>
              </section>

              <section className="flex flex-col gap-3">
                <div className="flex items-center gap-2.5">
                  <Tick />
                  <h2
                    id={sortHeadingId}
                    className="font-serif text-[18px] italic leading-none text-mute"
                  >
                    Sort pages
                  </h2>
                </div>
                <RadioGroup
                  segmented
                  aria-labelledby={sortHeadingId}
                  value={sort}
                  onChange={(value) => onSortChange(value as GazetteerSort)}
                  className="pl-[17px]"
                  optionsClassName="w-full flex-wrap"
                >
                  {sortOptions.map((option) => (
                    <Radio
                      key={option.value}
                      value={option.value}
                      className="min-h-10 flex-1 justify-center px-3 text-[14px]"
                    >
                      {option.label}
                    </Radio>
                  ))}
                </RadioGroup>
              </section>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  );
}
