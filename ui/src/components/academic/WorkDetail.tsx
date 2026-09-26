import { useId, useState } from "react";
import {
  type AnnotationType,
  type ReadingStatus,
  useAnnotations,
  useCreateAnnotation,
  useUpdateWork,
  useWork,
} from "#/api/academic";
import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { Select, SelectItem } from "#/components/ui/select";
import { TextField } from "#/components/ui/text-field";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

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

/** "highlight" → "Highlight": vocabulary values read in sentence case. */
function sentence(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const value = children || "—";
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-[12.5px] text-mute">{label}</dt>
      <dd
        className={cn(
          "min-w-0 break-words text-[14px]",
          value === "—" ? "text-mute" : "text-ink",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

export function WorkDetail({ workId }: { workId: string }) {
  const id = useId();
  const openPage = useOpenTab();
  const workQuery = useWork(workId);
  const annotationQuery = useAnnotations(workId);
  const updateWork = useUpdateWork();
  const createAnnotation = useCreateAnnotation();
  const [editOpen, setEditOpen] = useState(false);
  const [annotationOpen, setAnnotationOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [authors, setAuthors] = useState("");
  const [year, setYear] = useState("");
  const [status, setStatus] = useState<ReadingStatus | "">("");
  const [rating, setRating] = useState("");
  const [venue, setVenue] = useState("");
  const [publisher, setPublisher] = useState("");
  const [citeKey, setCiteKey] = useState("");
  const [tags, setTags] = useState("");
  const [annotationType, setAnnotationType] =
    useState<AnnotationType>("highlight");
  const [annotationBody, setAnnotationBody] = useState("");
  const [sourceAsset, setSourceAsset] = useState("");
  const [sourcePage, setSourcePage] = useState("");
  const [sourceQuote, setSourceQuote] = useState("");
  const [annotationTags, setAnnotationTags] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (workQuery.isPending) {
    return <p className="p-6 text-[13.5px] text-mute">Loading work…</p>;
  }
  if (workQuery.error || !workQuery.data) {
    return (
      <p role="alert" className="p-6 text-[13.5px] text-hot">
        {formatError(workQuery.error, "Work could not be loaded.")}
      </p>
    );
  }

  const work = workQuery.data;
  const annotations = annotationQuery.data ?? [];

  function openEditor() {
    setTitle(work.title);
    setAuthors((work.authors ?? []).join(", "));
    setYear(work.year?.toString() ?? "");
    setStatus(work.status ?? "");
    setRating(work.rating?.toString() ?? "");
    setVenue(work.venue ?? "");
    setPublisher(work.publisher ?? "");
    setCiteKey(work.cite_key ?? "");
    setTags((work.tags ?? []).join(", "));
    setError(null);
    setEditOpen(true);
  }

  async function saveMetadata() {
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
    const parsedRating = rating.trim() ? Number(rating) : undefined;
    if (
      parsedRating !== undefined &&
      (!Number.isInteger(parsedRating) || parsedRating < 1 || parsedRating > 5)
    ) {
      setError("Rating must be between 1 and 5.");
      return;
    }

    setError(null);
    try {
      await updateWork.mutateAsync({
        params: { path: { uuid: work.id } },
        body: {
          title: nextTitle,
          authors: splitValues(authors),
          year: parsedYear ?? null,
          status: status || null,
          rating: parsedRating ?? null,
          venue: venue.trim() || null,
          publisher: publisher.trim() || null,
          cite_key: citeKey.trim() || null,
          tags: splitValues(tags),
        },
      });
      setEditOpen(false);
    } catch (updateError) {
      setError(formatError(updateError, "Work metadata could not be saved."));
    }
  }

  function openAnnotationEditor() {
    setAnnotationType("highlight");
    setAnnotationBody("");
    setSourceAsset("");
    setSourcePage("");
    setSourceQuote("");
    setAnnotationTags("");
    setError(null);
    setAnnotationOpen(true);
  }

  async function createNewAnnotation() {
    const body = annotationBody.trim();
    if (!body) {
      setError("Annotation body is required.");
      return;
    }
    const page = sourcePage.trim() ? Number(sourcePage) : undefined;
    if (page !== undefined && (!Number.isInteger(page) || page < 1)) {
      setError("Source page must be a positive whole number.");
      return;
    }
    const quote = sourceQuote.trim();
    const sourceLocation =
      page !== undefined || quote
        ? { ...(page ? { page } : {}), ...(quote ? { quote } : {}) }
        : undefined;

    setError(null);
    try {
      await createAnnotation.mutateAsync({
        body: {
          work_id: work.id,
          annotation_type: annotationType,
          body,
          tags: splitValues(annotationTags),
          ...(sourceAsset.trim() ? { source_asset: sourceAsset.trim() } : {}),
          ...(sourceLocation ? { source_location: sourceLocation } : {}),
        },
      });
      setAnnotationOpen(false);
    } catch (annotationError) {
      setError(
        formatError(annotationError, "Annotation could not be created."),
      );
    }
  }

  return (
    <article
      aria-labelledby={`${id}-title`}
      className="h-full overflow-y-auto rounded-2xl bg-raise"
    >
      <div className="flex flex-col gap-8 px-6 py-7 md:px-12 md:py-9">
        <div className="flex flex-wrap items-start gap-6">
          <div className="flex min-w-0 flex-1 flex-col gap-2.5">
            <span className="flex items-center gap-2.5">
              <Tick />
              <span className="font-serif text-[19px] italic text-mute">
                {sentence(work.work_type)} · {work.year ?? "Undated"}
              </span>
            </span>
            <h2
              id={`${id}-title`}
              className="font-serif text-[34px] leading-[1.05] tracking-[-0.01em] text-ink md:text-[44px]"
            >
              {work.title}
            </h2>
            <p className="text-[15px] text-ink-2">
              {(work.authors ?? []).join(", ") || "Unknown author"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 md:pt-[30px]">
            <Button onPress={openEditor}>Edit metadata</Button>
            <Button
              variant="primary"
              onPress={() => openPage("page", work.path, work.title)}
            >
              Open work page
            </Button>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-[18px] xl:grid-cols-4">
          <DetailRow label="Status">
            {sentence(work.status ?? "unread")}
          </DetailRow>
          <DetailRow label="Rating">
            {work.rating ? `${work.rating} / 5` : "—"}
          </DetailRow>
          <DetailRow label="Venue">{work.venue ?? "—"}</DetailRow>
          <DetailRow label="Publisher">{work.publisher ?? "—"}</DetailRow>
          <DetailRow label="Cite key">{work.cite_key ?? "—"}</DetailRow>
          <DetailRow label="DOI">{work.external_ids?.doi ?? "—"}</DetailRow>
          <DetailRow label="ISBN">{work.external_ids?.isbn ?? "—"}</DetailRow>
          <DetailRow label="Tags">
            {(work.tags ?? []).join(", ") || "—"}
          </DetailRow>
        </dl>

        {work.body ? (
          <section
            className="flex flex-col gap-2.5"
            aria-labelledby={`${id}-notes`}
          >
            <h3
              id={`${id}-notes`}
              className="flex items-center gap-2.5 font-serif text-[20px] italic text-mute"
            >
              <Tick variant="faint" />
              Notes
            </h3>
            <p className="whitespace-pre-wrap pl-[17px] text-[15px] leading-[1.65] text-ink-2">
              {work.body}
            </p>
          </section>
        ) : null}

        <section
          className="flex flex-col gap-3"
          aria-labelledby={`${id}-annotations`}
        >
          <div className="flex items-center gap-3">
            <h3
              id={`${id}-annotations`}
              className="flex flex-1 items-center gap-2.5 font-serif text-[20px] italic text-ink"
            >
              <Tick />
              Annotations
              <span className="font-sans text-[13px] not-italic text-mute">
                {annotations.length}
              </span>
            </h3>
            <Button size="sm" onPress={openAnnotationEditor}>
              Add annotation
            </Button>
          </div>
          <div className="pl-[17px]">
            {annotationQuery.isPending ? (
              <p className="text-[13.5px] text-mute">Loading annotations…</p>
            ) : annotationQuery.error ? (
              <p role="alert" className="text-[13.5px] text-hot">
                {formatError(
                  annotationQuery.error,
                  "Annotations could not be loaded.",
                )}
              </p>
            ) : annotations.length === 0 ? (
              <p className="text-[13.5px] text-mute">
                No annotations for this work.
              </p>
            ) : (
              <ul className="flex flex-col gap-4">
                {annotations.map((annotation) => {
                  const label = annotation.body || annotation.path;
                  return (
                    <li key={annotation.id} className="flex items-start gap-5">
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <p className="whitespace-pre-wrap text-[15px] leading-[1.55] text-ink-2">
                          {label}
                        </p>
                        <p className="text-[12.5px] text-mute">
                          {sentence(annotation.annotation_type ?? "annotation")}
                          {annotation.source_location?.page
                            ? ` · page ${annotation.source_location.page}`
                            : ""}
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-label={`Open annotation ${label}`}
                        className={cn(
                          "flex-shrink-0 cursor-pointer rounded-sm pt-0.5 text-[13px] text-accent hover:underline",
                          FOCUS_RING_NATIVE,
                        )}
                        onClick={() => openPage("page", annotation.path, label)}
                      >
                        Open page
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="mt-3 text-[12.5px] text-mute">
              Open an annotation page to edit it or use previewed page deletion.
            </p>
          </div>
        </section>
      </div>

      <Dialog
        isOpen={editOpen}
        onOpenChange={(open) => {
          if (!open && !updateWork.isPending) setEditOpen(false);
        }}
        title="Edit academic work"
        size="lg"
        isDismissable={!updateWork.isPending}
        footer={
          <>
            <Button
              variant="secondary"
              onPress={() => setEditOpen(false)}
              isDisabled={updateWork.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onPress={() => void saveMetadata()}
              isDisabled={updateWork.isPending}
            >
              {updateWork.isPending ? "Saving…" : "Save metadata"}
            </Button>
          </>
        }
      >
        <div className="grid gap-3 md:grid-cols-2">
          <TextField
            label="Title"
            value={title}
            onChange={setTitle}
            className="md:col-span-2"
          />
          <TextField
            label="Authors"
            value={authors}
            onChange={setAuthors}
            description="Separate names with commas."
            className="md:col-span-2"
          />
          <TextField
            label="Year"
            type="number"
            value={year}
            onChange={setYear}
          />
          <Select
            label="Reading status"
            selectedKey={status}
            onSelectionChange={(key) => setStatus(key as ReadingStatus | "")}
            className="w-full"
          >
            <SelectItem id="">Unspecified</SelectItem>
            <SelectItem id="unread">Unread</SelectItem>
            <SelectItem id="reading">Reading</SelectItem>
            <SelectItem id="done">Done</SelectItem>
          </Select>
          <TextField
            label="Rating"
            type="number"
            value={rating}
            onChange={setRating}
          />
          <TextField
            label="Citation key"
            value={citeKey}
            onChange={setCiteKey}
          />
          <TextField label="Venue" value={venue} onChange={setVenue} />
          <TextField
            label="Publisher"
            value={publisher}
            onChange={setPublisher}
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

      <Dialog
        isOpen={annotationOpen}
        onOpenChange={(open) => {
          if (!open && !createAnnotation.isPending) setAnnotationOpen(false);
        }}
        title="Add annotation"
        size="lg"
        isDismissable={!createAnnotation.isPending}
        footer={
          <>
            <Button
              variant="secondary"
              onPress={() => setAnnotationOpen(false)}
              isDisabled={createAnnotation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onPress={() => void createNewAnnotation()}
              isDisabled={createAnnotation.isPending}
            >
              {createAnnotation.isPending ? "Creating…" : "Create annotation"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Select
            label="Annotation type"
            selectedKey={annotationType}
            onSelectionChange={(key) =>
              setAnnotationType(key as AnnotationType)
            }
            className="w-full"
          >
            <SelectItem id="highlight">Highlight</SelectItem>
            <SelectItem id="note">Note</SelectItem>
          </Select>
          <div className="flex flex-col">
            <label
              htmlFor={`${id}-annotation-body`}
              className="text-[12.5px] text-mute"
            >
              Annotation body
            </label>
            <textarea
              id={`${id}-annotation-body`}
              value={annotationBody}
              onChange={(event) => setAnnotationBody(event.target.value)}
              rows={5}
              className={cn(
                "mt-1.5 w-full resize-y rounded-xl bg-sink px-4 py-3 text-[14px] leading-[1.55] text-ink",
                FOCUS_RING_NATIVE,
              )}
            />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <TextField
              label="Source asset"
              value={sourceAsset}
              onChange={setSourceAsset}
            />
            <TextField
              label="Source page"
              type="number"
              value={sourcePage}
              onChange={setSourcePage}
            />
          </div>
          <TextField
            label="Source quote"
            value={sourceQuote}
            onChange={setSourceQuote}
          />
          <TextField
            label="Tags"
            value={annotationTags}
            onChange={setAnnotationTags}
            description="Separate tags with commas."
          />
          {error ? (
            <p role="alert" className="text-[13.5px] text-hot">
              {error}
            </p>
          ) : null}
        </div>
      </Dialog>
    </article>
  );
}
