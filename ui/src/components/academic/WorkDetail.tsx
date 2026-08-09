import { useId, useState } from "react";
import {
  type AnnotationType,
  type ReadingStatus,
  useAnnotations,
  useCreateAnnotation,
  useUpdateWork,
  useWork,
} from "#/api/academic";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { TextField } from "#/components/ui/text-field";
import { useOpenTab } from "#/hooks/useOpenTab";

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

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[100px_1fr] gap-3 border-b border-rule-soft py-1.5 text-sm">
      <dt className="cl-mono text-[9px] uppercase tracking-[0.14em] text-ink-mute">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-ink-2">{children || "—"}</dd>
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
    return <p className="cl-marg p-6">Loading work…</p>;
  }
  if (workQuery.error || !workQuery.data) {
    return (
      <p role="alert" className="p-6 text-sm text-destructive">
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
    <article className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl p-5 md:p-8">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rule pb-3">
          <div>
            <p className="cl-mono mb-1 text-[9px] uppercase tracking-[0.18em] text-ink-mute">
              {work.work_type} / {work.year ?? "undated"}
            </p>
            <h2 className="font-heading text-xl font-bold text-ink">
              {work.title}
            </h2>
            <p className="mt-1 text-sm text-ink-mute">
              {(work.authors ?? []).join(", ") || "Unknown author"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onPress={openEditor}>
              Edit metadata
            </Button>
            <Button
              size="sm"
              variant="primary"
              onPress={() => openPage("page", work.path, work.title)}
            >
              Open work page
            </Button>
          </div>
        </div>

        <dl className="mt-4">
          <DetailRow label="Status">{work.status ?? "unread"}</DetailRow>
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
          <section className="mt-5" aria-labelledby={`${id}-notes`}>
            <h3
              id={`${id}-notes`}
              className="cl-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute"
            >
              Notes
            </h3>
            <p className="mt-2 whitespace-pre-wrap text-sm text-ink-2">
              {work.body}
            </p>
          </section>
        ) : null}

        <section className="mt-7" aria-labelledby={`${id}-annotations`}>
          <div className="flex items-center justify-between gap-3 border-b border-rule pb-2">
            <h3
              id={`${id}-annotations`}
              className="font-heading text-base font-bold"
            >
              Annotations · {annotations.length}
            </h3>
            <Button size="sm" variant="primary" onPress={openAnnotationEditor}>
              Add annotation
            </Button>
          </div>
          {annotationQuery.isPending ? (
            <p className="cl-marg py-4">Loading annotations…</p>
          ) : annotationQuery.error ? (
            <p role="alert" className="py-4 text-sm text-destructive">
              {formatError(
                annotationQuery.error,
                "Annotations could not be loaded.",
              )}
            </p>
          ) : annotations.length === 0 ? (
            <p className="cl-marg py-4">No annotations for this work.</p>
          ) : (
            <ul className="divide-y divide-rule-soft">
              {annotations.map((annotation) => {
                const label = annotation.body || annotation.path;
                return (
                  <li key={annotation.id} className="py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="whitespace-pre-wrap text-sm text-ink-2">
                          {label}
                        </p>
                        <p className="cl-mono mt-1 text-[9px] uppercase tracking-[0.12em] text-ink-mute">
                          {annotation.annotation_type ?? "annotation"}
                          {annotation.source_location?.page
                            ? ` · page ${annotation.source_location.page}`
                            : ""}
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-label={`Open annotation ${label}`}
                        className="cl-mono flex-shrink-0 text-[10px] uppercase tracking-wider text-accent hover:underline"
                        onClick={() => openPage("page", annotation.path, label)}
                      >
                        Open page
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="cl-marg mt-3">
            Open an annotation page to edit it or use previewed page deletion.
          </p>
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
          <div>
            <label
              htmlFor={`${id}-status`}
              className="text-xs font-bold uppercase tracking-widest text-muted-foreground"
            >
              Reading status
            </label>
            <select
              id={`${id}-status`}
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as ReadingStatus | "")
              }
              className="mt-2 w-full border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Unspecified</option>
              <option value="unread">Unread</option>
              <option value="reading">Reading</option>
              <option value="done">Done</option>
            </select>
          </div>
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
            <p role="alert" className="text-sm text-destructive md:col-span-2">
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
          <div>
            <label
              htmlFor={`${id}-annotation-type`}
              className="text-xs font-bold uppercase tracking-widest text-muted-foreground"
            >
              Annotation type
            </label>
            <select
              id={`${id}-annotation-type`}
              value={annotationType}
              onChange={(event) =>
                setAnnotationType(event.target.value as AnnotationType)
              }
              className="mt-2 w-full border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="highlight">Highlight</option>
              <option value="note">Note</option>
            </select>
          </div>
          <div>
            <label
              htmlFor={`${id}-annotation-body`}
              className="text-xs font-bold uppercase tracking-widest text-muted-foreground"
            >
              Annotation body
            </label>
            <textarea
              id={`${id}-annotation-body`}
              value={annotationBody}
              onChange={(event) => setAnnotationBody(event.target.value)}
              rows={5}
              className="mt-2 w-full resize-y border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring"
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
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </Dialog>
    </article>
  );
}
