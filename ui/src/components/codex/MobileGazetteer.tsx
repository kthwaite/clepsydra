import { useState } from "react";
import {
  Button as AriaButton,
  Dialog,
  Heading,
  ListBox,
  ListBoxItem,
  Modal,
  ModalOverlay,
  Popover,
  Select,
} from "react-aria-components";
import type { ContentEntry, TagCount } from "#/api/types";
import { ProjectCombo } from "#/components/codex/ProjectCombo";
import { Button } from "#/components/ui/button";
import { TagInput } from "#/components/ui/tag-input";
import { Radio, RadioGroup } from "#/components/ui/radio-group";
import { TextField } from "#/components/ui/text-field";
import {
  KINDS,
  type Kind,
  kindColorVar,
  kindLabel,
  resolveKind,
} from "#/lib/kind";
import { formatRelativeTime } from "#/lib/time";
import type { GazetteerSort } from "./gazetteer-filter";

export interface MobileGazetteerProps {
  query: string;
  selectedTags: string[];
  kind?: Kind;
  project?: string;
  projects: string[];
  sort: GazetteerSort;
  rows: ContentEntry[];
  tags: TagCount[];
  tagsLoading: boolean;
  tagsError: unknown;
  onRetryTags: () => void;
  totalCount: number;
  filteredCount: number;
  page: number;
  pageCount: number;
  onQueryChange: (query: string) => void;
  onSelectedTagsChange: (tags: string[]) => void;
  onKindChange: (kind?: Kind) => void;
  onProjectChange: (project?: string) => void;
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

const sheetButtonClass =
  "cl-mono inline-flex min-h-11 items-center justify-center px-4 text-[10px] uppercase tracking-[0.12em] text-ink-2 outline-none transition-colors data-[hovered]:bg-highlight data-[focus-visible]:ring-2 data-[focus-visible]:ring-accent";

export function MobileGazetteer({
  query,
  selectedTags,
  kind,
  project,
  projects,
  sort,
  rows,
  tags,
  tagsLoading,
  tagsError,
  onRetryTags,
  totalCount,
  filteredCount,
  page,
  pageCount,
  onQueryChange,
  onSelectedTagsChange,
  onKindChange,
  onProjectChange,
  onSortChange,
  onPageChange,
  onOpen,
}: MobileGazetteerProps) {
  const [filtersOpen, setFiltersOpen] = useState(false);

  const activeFilterCount =
    selectedTags.length + (query ? 1 : 0) + (kind ? 1 : 0) + (project ? 1 : 0);

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper text-ink">
      <header className="flex min-h-11 shrink-0 items-stretch border-b border-rule pl-4">
        <div className="flex min-w-0 flex-1 items-center gap-3 py-2">
          <h1 className="font-sans text-[17px] font-black uppercase tracking-[0.04em]">
            Gazetteer<span className="text-accent"> / </span>Index
          </h1>
          <span className="cl-mono text-[9px] uppercase tracking-[0.12em] text-ink-mute">
            {filteredCount} of {totalCount}
          </span>
        </div>
        <AriaButton
          className={sheetButtonClass}
          onPress={() => setFiltersOpen(true)}
        >
          Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}
        </AriaButton>
      </header>

      <div className="cl-noscroll min-h-0 flex-1 overflow-y-auto">
        {rows.length > 0 ? (
          <ul aria-label="Vault pages" className="divide-y divide-rule-soft">
            {rows.map((row) => {
              const title = row.title || row.path;
              const kind = resolveKind({ path: row.path, kind: row.kind });
              const wordCount = row.word_count;

              return (
                <li key={row.path} className="px-4 py-3">
                  <article className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2">
                    <div className="min-w-0">
                      <h2 className="font-sans text-[15px] font-semibold leading-snug text-ink">
                        {title}
                      </h2>
                      <p className="cl-mono mt-1 break-all text-[10px] leading-relaxed text-ink-mute">
                        {row.path}
                      </p>
                    </div>
                    <Button
                      aria-label={`Open ${title}`}
                      className="min-h-11 self-start"
                      onPress={() => onOpen(row.path, title)}
                    >
                      Open
                    </Button>

                    <div className="col-span-2 flex flex-wrap items-center gap-x-2 gap-y-1 cl-mono text-[10px] leading-relaxed text-ink-2">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          aria-hidden="true"
                          className="h-1.5 w-1.5 shrink-0"
                          style={{ background: kindColorVar(kind) }}
                        />
                        {kindLabel(kind)}
                      </span>
                      <span aria-hidden="true" className="text-ink-faint">
                        ·
                      </span>
                      <span>{row.project || "No project"}</span>
                    </div>

                    <div className="col-span-2 flex flex-wrap gap-1.5">
                      {row.tags.length > 0 ? (
                        row.tags.map((tag) => (
                          <span
                            key={tag}
                            className="cl-mono border border-rule-soft px-1.5 py-0.5 text-[9px] text-accent"
                          >
                            #{tag}
                          </span>
                        ))
                      ) : (
                        <span className="cl-mono text-[9px] text-ink-mute">
                          No tags
                        </span>
                      )}
                    </div>

                    <div className="col-span-2 flex items-center justify-between border-t border-dotted border-rule-soft pt-2 cl-mono text-[9px] uppercase tracking-[0.08em] text-ink-mute">
                      <span>
                        {wordCount == null
                          ? "Words unavailable"
                          : `${wordCount} ${wordCount === 1 ? "word" : "words"}`}
                      </span>
                      <span>Edited {formatRelativeTime(row.updated_at)}</span>
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="px-6 py-12 text-center">
            <p className="cl-marg">∅ no folios match these filters.</p>
            <p className="cl-mono mt-2 text-[10px] text-ink-mute">
              Adjust the search or selected tags in Filters.
            </p>
          </div>
        )}
      </div>

      <nav
        aria-label="Gazetteer pagination"
        className="flex min-h-12 shrink-0 items-center gap-2 border-t border-rule bg-paper-2 px-3 py-1"
      >
        <Button
          aria-label="Previous page"
          className="min-h-11 min-w-11"
          isDisabled={page <= 1}
          onPress={() => onPageChange(page - 1)}
        >
          Previous
        </Button>
        <span
          role="status"
          aria-live="polite"
          className="cl-mono min-w-0 flex-1 text-center text-[10px] uppercase tracking-[0.1em] text-ink-mute"
        >
          Page {page} of {pageCount} · {filteredCount}{" "}
          {filteredCount === 1 ? "match" : "matches"}
        </span>
        <Button
          aria-label="Next page"
          className="min-h-11 min-w-11"
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
        className="fixed inset-0 z-50 flex justify-end bg-foreground/30"
      >
        <Modal className="h-dvh w-full max-w-md bg-paper-2 shadow-lg outline-none">
          <Dialog
            aria-label="Gazetteer filters"
            className="flex h-full min-h-0 flex-col outline-none [&_button]:min-h-11 [&_input]:min-h-11"
          >
            <div className="flex min-h-11 shrink-0 items-stretch border-b border-rule pl-4">
              <Heading
                slot="title"
                className="cl-mono flex min-w-0 flex-1 items-center text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-2"
              >
                Gazetteer filters
              </Heading>
              <AriaButton
                aria-label="Close filters"
                className={sheetButtonClass}
                onPress={() => setFiltersOpen(false)}
              >
                Close
              </AriaButton>
            </div>

            <div className="cl-noscroll min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              <TextField
                label="Search pages"
                type="search"
                value={query}
                onChange={onQueryChange}
                placeholder="Title, path, description, or tag"
              />
              <section
                aria-label="Kind and Project filters"
                className="grid gap-4 sm:grid-cols-2"
              >
                <Select
                  aria-label="Filter by kind"
                  selectedKey={kind ?? "all"}
                  onSelectionChange={(key) =>
                    onKindChange(key === "all" ? undefined : (key as Kind))
                  }
                >
                  <AriaButton className="cl-mono flex min-h-11 w-full items-center border border-rule px-3 text-left text-[11px] uppercase tracking-[0.08em] text-ink-2 outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-accent">
                    {kind ? kindLabel(kind) : "All kinds"}
                  </AriaButton>
                  <Popover className="border border-rule bg-paper outline-none">
                    <ListBox className="cl-mono max-h-[280px] overflow-auto p-0.5 outline-none">
                      <ListBoxItem
                        id="all"
                        className="cursor-pointer px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-ink-2 outline-none data-[focused]:bg-highlight"
                      >
                        All kinds
                      </ListBoxItem>
                      {KINDS.map((option) => (
                        <ListBoxItem
                          key={option}
                          id={option}
                          className="cursor-pointer px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-ink-2 outline-none data-[focused]:bg-highlight"
                        >
                          {kindLabel(option)}
                        </ListBoxItem>
                      ))}
                    </ListBox>
                  </Popover>
                </Select>
                <ProjectCombo
                  value={project ?? null}
                  options={projects}
                  ariaLabel="Filter by project"
                  menuTrigger="focus"
                  onAssign={onProjectChange}
                  onClear={() => onProjectChange(undefined)}
                />
              </section>

              <section aria-labelledby="gazetteer-tags-heading">
                <h2
                  id="gazetteer-tags-heading"
                  className="text-xs font-bold uppercase tracking-widest text-muted-foreground"
                >
                  Tags · all selected tags must match
                </h2>
                <div className="mt-2">
                  <TagInput
                    label="Tags"
                    ariaLabel="Filter by tags"
                    values={selectedTags}
                    suggestions={tags.map((tag) => tag.tag)}
                    suggestionsLoading={tagsLoading}
                    suggestionsError={tagsError}
                    onRetrySuggestions={onRetryTags}
                    allowCreate={false}
                    onChange={onSelectedTagsChange}
                    placeholder="filter tags…"
                    variant="codex"
                    valuePrefix="#"
                    maxSuggestions={8}
                  />
                  {selectedTags.length > 0 ? (
                    <Button onPress={() => onSelectedTagsChange([])}>
                      Clear tags
                    </Button>
                  ) : null}
                </div>
              </section>

              <RadioGroup
                aria-label="Sort pages"
                label="Sort pages"
                value={sort}
                onChange={(value) => onSortChange(value as GazetteerSort)}
                className="[&>div]:flex-wrap"
              >
                {sortOptions.map((option) => (
                  <Radio
                    key={option.value}
                    value={option.value}
                    className="min-h-11"
                  >
                    {option.label}
                  </Radio>
                ))}
              </RadioGroup>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  );
}
