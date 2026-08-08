import { useState } from "react";
import {
  Button as AriaButton,
  Dialog,
  Heading,
  Modal,
  ModalOverlay,
} from "react-aria-components";
import type { ContentEntry, TagCount } from "#/api/types";
import { Button } from "#/components/ui/button";
import { Radio, RadioGroup } from "#/components/ui/radio-group";
import { TextField } from "#/components/ui/text-field";
import { kindColorVar, kindLabel, resolveKind } from "#/lib/kind";
import { formatRelativeTime } from "#/lib/time";
import type { GazetteerSort } from "./gazetteer-filter";

export interface MobileGazetteerProps {
  query: string;
  selectedTags: string[];
  sort: GazetteerSort;
  rows: ContentEntry[];
  tags: TagCount[];
  totalCount: number;
  onQueryChange: (query: string) => void;
  onSelectedTagsChange: (tags: string[]) => void;
  onSortChange: (sort: GazetteerSort) => void;
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
  sort,
  rows,
  tags,
  totalCount,
  onQueryChange,
  onSelectedTagsChange,
  onSortChange,
  onOpen,
}: MobileGazetteerProps) {
  const [filtersOpen, setFiltersOpen] = useState(false);

  const toggleTag = (tag: string) => {
    onSelectedTagsChange(
      selectedTags.includes(tag)
        ? selectedTags.filter((selected) => selected !== tag)
        : [...selectedTags, tag],
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper text-ink">
      <header className="flex min-h-11 shrink-0 items-stretch border-b border-rule pl-4">
        <div className="flex min-w-0 flex-1 items-center gap-3 py-2">
          <h1 className="font-sans text-[17px] font-black uppercase tracking-[0.04em]">
            Gazetteer<span className="text-accent"> / </span>Index
          </h1>
          <span className="cl-mono text-[9px] uppercase tracking-[0.12em] text-ink-mute">
            {rows.length} of {totalCount}
          </span>
        </div>
        <AriaButton className={sheetButtonClass} onPress={() => setFiltersOpen(true)}>
          Filters{selectedTags.length > 0 || query ? ` · ${selectedTags.length + (query ? 1 : 0)}` : ""}
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
                      <span aria-hidden="true" className="text-ink-faint">·</span>
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
                        <span className="cl-mono text-[9px] text-ink-mute">No tags</span>
                      )}
                    </div>

                    <div className="col-span-2 flex items-center justify-between border-t border-dotted border-rule-soft pt-2 cl-mono text-[9px] uppercase tracking-[0.08em] text-ink-mute">
                      <span>{wordCount == null ? "Words unavailable" : `${wordCount} ${wordCount === 1 ? "word" : "words"}`}</span>
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

              <section aria-labelledby="gazetteer-tags-heading">
                <h2
                  id="gazetteer-tags-heading"
                  className="text-xs font-bold uppercase tracking-widest text-muted-foreground"
                >
                  Tags · all selected tags must match
                </h2>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    aria-label="Show all tags"
                    aria-pressed={selectedTags.length === 0}
                    variant={selectedTags.length === 0 ? "primary" : "secondary"}
                    onPress={() => onSelectedTagsChange([])}
                  >
                    All · {totalCount}
                  </Button>
                  {tags.map((tag) => {
                    const selected = selectedTags.includes(tag.tag);
                    return (
                      <Button
                        key={tag.tag}
                        aria-label={`Filter by ${tag.tag}`}
                        aria-pressed={selected}
                        variant={selected ? "primary" : "secondary"}
                        onPress={() => toggleTag(tag.tag)}
                      >
                        #{tag.tag} · {tag.count}
                      </Button>
                    );
                  })}
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
                  <Radio key={option.value} value={option.value} className="min-h-11">
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
