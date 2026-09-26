import { useMemo, useState } from "react";
import {
  type ReadingStatus,
  useCreateWork,
  useWorks,
  type WorkSummary,
  type WorkType,
} from "#/api/academic";
import { ImportDialog } from "#/components/academic/ImportDialog";
import { WorkDetail } from "#/components/academic/WorkDetail";
import { Tick } from "#/components/codex/Tick";
import { FilterBar } from "#/components/filters/FilterBar";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { Select, SelectItem } from "#/components/ui/select";
import { TextField } from "#/components/ui/text-field";
import { cn } from "#/lib/cn";
import {
  EMPTY_FILTER_STATE,
  type FilterField,
  type FilterState,
  isFilterActive,
} from "#/lib/filters/model";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

const PAGE_SIZE = 200;

/** WorkType union values (ui/src/api/schema.d.ts) — drive the work_type
 * facet's options and validate URL-arriving values before they reach the
 * server; `satisfies` fails loudly if the schema's union ever drifts. */
const WORK_TYPES = [
  "paper",
  "book",
  "thesis",
  "report",
  "other",
] as const satisfies readonly WorkType[];

/** ReadingStatus union values (ui/src/api/schema.d.ts) — same role as
 * WORK_TYPES for the status facet. */
const READING_STATUSES = [
  "unread",
  "reading",
  "done",
] as const satisfies readonly ReadingStatus[];

/** Narrow a facet's raw string value against the known vocabulary rather than
 * casting it blindly — an unrecognised value (e.g. a stale/hand-edited URL)
 * is simply omitted from the works request. */
function asWorkType(value: string | undefined): WorkType | undefined {
  return value !== undefined &&
    (WORK_TYPES as readonly string[]).includes(value)
    ? (value as WorkType)
    : undefined;
}

function asReadingStatus(value: string | undefined): ReadingStatus | undefined {
  return value !== undefined &&
    (READING_STATUSES as readonly string[]).includes(value)
    ? (value as ReadingStatus)
    : undefined;
}

/** Parse a facet's raw string value as a year, mirroring the
 * Number.isFinite guard used for numeric search params elsewhere
 * (feeds.tsx's `feed` param, gazetteer.tsx's `page` param) — an
 * unparseable value (e.g. `?year=abc`) is omitted rather than sent to the
 * server as `NaN`, which the backend's `Option<i32>` deserializer rejects. */
function asYear(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatError(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "error" in error &&
    typeof error.error === "string"
  ) {
    return error.error;
  }
  return fallback;
}

/** "paper" → "Paper": vocabulary values read in sentence case. */
function sentence(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Row meta line: "Book · 1914 · reading". */
function workMeta(work: WorkSummary): string {
  const parts = [
    sentence(work.work_type ?? "work"),
    work.year?.toString() ?? "Undated",
  ];
  if (work.status) parts.push(work.status);
  return parts.join(" · ");
}

function splitValues(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function matchesSearch(work: WorkSummary, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    work.title,
    work.path,
    work.cite_key,
    work.work_type,
    work.status,
    ...(work.authors ?? []),
    ...(work.tags ?? []),
    work.year?.toString(),
  ].some((value) => value?.toLowerCase().includes(normalized));
}

export function AcademicLibrary({
  filterState = EMPTY_FILTER_STATE,
  onFilterChange = () => {},
}: {
  filterState?: FilterState;
  onFilterChange?: (next: FilterState) => void;
} = {}) {
  const facet = (id: string) => filterState.facets[id]?.[0];
  const facetWorkType = facet("work_type");
  const facetStatus = facet("status");
  const facetYear = facet("year");
  const facetTag = facet("tag");
  const facetSignature = [facetWorkType, facetStatus, facetYear, facetTag].join(
    " ",
  );

  const [limit, setLimit] = useState(PAGE_SIZE);
  // The server result set changes whenever a facet changes, so the
  // load-more cursor must restart from the first page. Adjusted during
  // render (React's documented pattern for resetting state from a prop
  // change) rather than a useEffect, since the reset itself doesn't read
  // any of the facet values — only their identity as a change signal.
  const [limitFacetSignature, setLimitFacetSignature] =
    useState(facetSignature);
  if (facetSignature !== limitFacetSignature) {
    setLimitFacetSignature(facetSignature);
    setLimit(PAGE_SIZE);
  }

  const worksQuery = useWorks({
    limit,
    work_type: asWorkType(facetWorkType),
    status: asReadingStatus(facetStatus),
    year: asYear(facetYear),
    tag: facetTag,
  });
  const createWork = useCreateWork();
  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [workType, setWorkType] = useState<WorkType>("paper");
  const [title, setTitle] = useState("");
  const [authors, setAuthors] = useState("");
  const [year, setYear] = useState("");
  const [status, setStatus] = useState<ReadingStatus>("unread");
  const [citeKey, setCiteKey] = useState("");
  const [tags, setTags] = useState("");
  const [error, setError] = useState<string | null>(null);

  const items = worksQuery.data?.items ?? [];
  const total = worksQuery.data?.total ?? items.length;
  const hasMore = total > items.length;
  const query = filterState.text;
  const filterActive = isFilterActive(filterState);
  const filteredWorks = useMemo(
    () => items.filter((work) => matchesSearch(work, query)),
    [items, query],
  );

  const filterFields: FilterField[] = useMemo(
    () => [
      {
        id: "work_type",
        kind: "single",
        label: "Type",
        options: WORK_TYPES.map((value) => ({ value })),
      },
      {
        id: "status",
        kind: "single",
        label: "Status",
        options: READING_STATUSES.map((value) => ({ value })),
      },
      {
        id: "year",
        kind: "single",
        label: "Year",
        options: [
          ...new Set(
            items
              .map((work) => work.year)
              .filter((y): y is number => typeof y === "number"),
          ),
        ]
          .sort((a, b) => b - a)
          .map((value) => ({ value: String(value) })),
      },
      {
        id: "tag",
        kind: "single",
        label: "Tag",
        options: [...new Set(items.flatMap((work) => work.tags ?? []))]
          .sort()
          .map((value) => ({ value })),
      },
    ],
    [items],
  );

  function openCreate() {
    setWorkType("paper");
    setTitle("");
    setAuthors("");
    setYear("");
    setStatus("unread");
    setCiteKey("");
    setTags("");
    setError(null);
    setCreateOpen(true);
  }

  async function create() {
    const nextTitle = title.trim();
    if (!nextTitle) {
      setError("Title is required.");
      return;
    }
    const parsedYear = year.trim() ? Number(year) : undefined;
    if (parsedYear !== undefined && !Number.isInteger(parsedYear)) {
      setError("Year must be a whole number.");
      return;
    }
    setError(null);
    try {
      const created = await createWork.mutateAsync({
        body: {
          work_type: workType,
          title: nextTitle,
          authors: splitValues(authors),
          year: parsedYear,
          status,
          cite_key: citeKey.trim() || undefined,
          tags: splitValues(tags),
        },
      });
      setSelectedWorkId(created.id);
      setCreateOpen(false);
    } catch (createError) {
      setError(formatError(createError, "Work could not be created."));
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-shrink-0 flex-wrap items-end gap-x-8 gap-y-4 px-4 pt-8 md:px-10 md:pt-11">
        <div className="flex flex-col gap-2.5">
          <span className="flex items-center gap-2.5">
            <Tick />
            <span className="font-serif text-[19px] italic text-mute">
              Research
            </span>
          </span>
          <h1 className="font-serif text-[44px] leading-none tracking-[-0.015em] text-ink md:text-[56px]">
            Academic library
          </h1>
        </div>
        <span className="pb-2 text-[14px] text-mute">
          {total} {total === 1 ? "work" : "works"}
        </span>
        <div className="flex-1" />
        <div className="flex gap-2">
          <Button onPress={() => setImportOpen(true)}>Import</Button>
          <Button variant="primary" onPress={openCreate}>
            Add work
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 gap-10 px-4 pt-9 pb-6 md:grid-cols-[minmax(260px,400px)_minmax(0,1fr)] md:px-10">
        <aside className="flex min-h-[280px] min-w-0 flex-col gap-3.5 md:min-h-0">
          <FilterBar
            fields={filterFields}
            primaryFieldIds={["work_type", "status", "year"]}
            state={filterState}
            onChange={onFilterChange}
            textPlaceholder="Title, author, citation key…"
            textAriaLabel="Search works"
            className="flex-wrap"
          />
          {filterActive ? (
            <p className="px-1 text-[12.5px] tabular-nums text-mute">
              {filteredWorks.length} of {total} works
            </p>
          ) : null}

          <div className="-mx-4 min-h-0 flex-1 overflow-y-auto px-1 py-1">
            {worksQuery.isPending ? (
              <p className="px-3 py-2 text-[13.5px] text-mute">
                Loading works…
              </p>
            ) : worksQuery.error ? (
              <p role="alert" className="px-3 py-2 text-[13.5px] text-hot">
                {formatError(
                  worksQuery.error,
                  "Academic works could not be loaded.",
                )}
              </p>
            ) : filteredWorks.length === 0 ? (
              <p className="px-3 py-2 text-[13.5px] text-mute">
                {filterActive
                  ? hasMore
                    ? "No loaded works match this search. Load more to continue searching."
                    : "No works match this search."
                  : "No academic works yet."}
              </p>
            ) : (
              <ul aria-label="Works" className="flex flex-col gap-0.5">
                {filteredWorks.map((work) => {
                  const label = work.title || work.path;
                  const isSelected = selectedWorkId === work.id;
                  return (
                    <li key={work.id}>
                      <button
                        type="button"
                        aria-label={`Open ${label}`}
                        aria-current={isSelected ? "true" : undefined}
                        onClick={() => setSelectedWorkId(work.id)}
                        className={cn(
                          "flex w-full cursor-pointer flex-col gap-[3px] rounded-xl px-3 py-[11px] text-left transition-colors",
                          isSelected ? "bg-accent-tint" : "hover:bg-sink",
                          FOCUS_RING_NATIVE,
                        )}
                      >
                        <span className="text-[14.5px] font-medium leading-[1.4] text-ink">
                          {label}
                        </span>
                        <span className="text-[13px] text-ink-2">
                          {(work.authors ?? []).join(", ") || "Unknown author"}
                        </span>
                        <span className="text-[12.5px] text-mute">
                          {workMeta(work)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {hasMore ? (
            <div className="flex flex-col gap-2">
              <p className="text-[12.5px] text-mute">
                Showing the first {items.length} of {total} works.
              </p>
              <Button
                size="sm"
                className="w-full"
                onPress={() =>
                  setLimit((current) => Math.min(current + PAGE_SIZE, total))
                }
                isDisabled={worksQuery.isFetching}
              >
                {worksQuery.isFetching ? "Loading…" : "Load more works"}
              </Button>
            </div>
          ) : null}
        </aside>

        <section className="min-h-[360px] min-w-0 md:min-h-0">
          {selectedWorkId ? (
            <WorkDetail workId={selectedWorkId} />
          ) : (
            <div className="flex h-full min-h-[360px] items-center justify-center rounded-2xl bg-raise p-8 text-center">
              <div>
                <p className="font-serif text-[26px] italic text-ink">
                  Select a work
                </p>
                <p className="mt-2 max-w-sm text-[13.5px] text-mute">
                  Review metadata and annotations, or import a bibliography to
                  grow the library.
                </p>
              </div>
            </div>
          )}
        </section>
      </div>

      <Dialog
        isOpen={createOpen}
        onOpenChange={(open) => {
          if (!open && !createWork.isPending) setCreateOpen(false);
        }}
        title="Add academic work"
        description="Create a work-backed Markdown page in the configured academic folder."
        size="lg"
        isDismissable={!createWork.isPending}
        footer={
          <>
            <Button
              variant="secondary"
              onPress={() => setCreateOpen(false)}
              isDisabled={createWork.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onPress={() => void create()}
              isDisabled={createWork.isPending}
            >
              {createWork.isPending ? "Creating…" : "Create work"}
            </Button>
          </>
        }
      >
        <div className="grid gap-3 md:grid-cols-2">
          <Select
            label="Work type"
            selectedKey={workType}
            onSelectionChange={(key) => setWorkType(key as WorkType)}
            className="w-full"
          >
            <SelectItem id="paper">Paper</SelectItem>
            <SelectItem id="book">Book</SelectItem>
            <SelectItem id="thesis">Thesis</SelectItem>
            <SelectItem id="report">Report</SelectItem>
            <SelectItem id="other">Other</SelectItem>
          </Select>
          <TextField
            label="Year"
            type="number"
            value={year}
            onChange={setYear}
          />
          <TextField
            label="Title"
            value={title}
            onChange={setTitle}
            autoFocus
            className="md:col-span-2"
          />
          <TextField
            label="Authors"
            value={authors}
            onChange={setAuthors}
            description="Separate names with commas."
            className="md:col-span-2"
          />
          <Select
            label="Reading status"
            selectedKey={status}
            onSelectionChange={(key) => setStatus(key as ReadingStatus)}
            className="w-full"
          >
            <SelectItem id="unread">Unread</SelectItem>
            <SelectItem id="reading">Reading</SelectItem>
            <SelectItem id="done">Done</SelectItem>
          </Select>
          <TextField
            label="Citation key"
            value={citeKey}
            onChange={setCiteKey}
          />
          <TextField
            label="Tags"
            value={tags}
            onChange={setTags}
            description="Separate tags with commas."
            className="md:col-span-2"
          />
          {error ? (
            <p role="alert" className="text-[13.5px] text-hot md:col-span-2">
              {error}
            </p>
          ) : null}
        </div>
      </Dialog>

      <ImportDialog isOpen={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}
