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
        label: "TYPE",
        options: WORK_TYPES.map((value) => ({ value })),
      },
      {
        id: "status",
        kind: "single",
        label: "STATUS",
        options: READING_STATUSES.map((value) => ({ value })),
      },
      {
        id: "year",
        kind: "single",
        label: "YEAR",
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
        label: "TAG",
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
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-4 py-3">
        <div>
          <p className="cl-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute">
            Research / Corpus
          </p>
          <h1 className="font-heading text-lg font-bold">Academic Library</h1>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onPress={() => setImportOpen(true)}>
            Import
          </Button>
          <Button size="sm" variant="primary" onPress={openCreate}>
            Add work
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(260px,340px)_1fr]">
        <aside className="flex min-h-[280px] flex-col border-b border-rule md:min-h-0 md:border-r md:border-b-0">
          <div className="border-b border-rule-soft px-3 py-3">
            <FilterBar
              fields={filterFields}
              state={filterState}
              onChange={onFilterChange}
              textPlaceholder="Title, author, citation key…"
              className="flex-wrap"
            />
            <div className="cl-mono mt-2 flex justify-between text-[9px] uppercase tracking-[0.12em] text-ink-mute">
              <span>{worksQuery.data?.total ?? items.length} works</span>
              {query ? <span>{filteredWorks.length} matches</span> : null}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {worksQuery.isPending ? (
              <p className="cl-marg p-4">Loading works…</p>
            ) : worksQuery.error ? (
              <p role="alert" className="p-4 text-sm text-destructive">
                {formatError(
                  worksQuery.error,
                  "Academic works could not be loaded.",
                )}
              </p>
            ) : filteredWorks.length === 0 ? (
              <p className="cl-marg p-4">
                {filterActive
                  ? hasMore
                    ? "No loaded works match this search. Load more to continue searching."
                    : "No works match this search."
                  : "No academic works yet."}
              </p>
            ) : (
              <ul>
                {filteredWorks.map((work) => {
                  const label = work.title || work.path;
                  return (
                    <li key={work.id}>
                      <button
                        type="button"
                        aria-label={`Open ${label}`}
                        aria-current={
                          selectedWorkId === work.id ? "true" : undefined
                        }
                        onClick={() => setSelectedWorkId(work.id)}
                        className={cn(
                          "w-full border-b border-rule-soft px-3 py-3 text-left hover:bg-ink/[0.035]",
                          selectedWorkId === work.id
                            ? "bg-ink/[0.05] shadow-[inset_2px_0_0_0_var(--accent)]"
                            : "",
                        )}
                      >
                        <span className="block text-sm font-medium text-ink">
                          {label}
                        </span>
                        <span className="mt-1 block text-xs text-ink-mute">
                          {(work.authors ?? []).join(", ") || "Unknown author"}
                        </span>
                        <span className="cl-mono mt-1 block text-[9px] uppercase tracking-[0.12em] text-ink-mute">
                          {work.work_type ?? "work"} · {work.year ?? "undated"}
                          {work.status ? ` · ${work.status}` : ""}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {hasMore ? (
            <div className="border-t border-rule-soft px-3 py-2">
              <p className="cl-marg mb-2">
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
            <div className="flex h-full min-h-[360px] items-center justify-center p-8 text-center">
              <div>
                <p className="font-heading text-base font-bold">
                  Select a work
                </p>
                <p className="cl-marg mt-2 max-w-sm">
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
            <p role="alert" className="text-sm text-destructive md:col-span-2">
              {error}
            </p>
          ) : null}
        </div>
      </Dialog>

      <ImportDialog isOpen={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}
