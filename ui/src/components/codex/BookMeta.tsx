import { usePage } from "#/api/pages";
import type { KindExtrasProps } from "#/lib/kindPresentation";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Book facts use the page query, so manually authored books need no library entry. */
export function BookMeta({ path, isDraft }: KindExtrasProps) {
  const { data: page } = usePage(path);
  // Page metadata includes arbitrary frontmatter beyond the named OpenAPI fields.
  const meta: Record<string, unknown> | undefined = page?.meta;
  if (isDraft || !meta) return null;

  const authors = Array.isArray(meta.authors)
    ? meta.authors.map(text).filter(Boolean).join(", ")
    : text(meta.authors);
  const ids = meta.external_ids;
  const isbn =
    ids && typeof ids === "object" && "isbn" in ids ? text(ids.isbn) : null;
  const status =
    meta.status === "unread"
      ? "Unread"
      : meta.status === "reading"
        ? "Reading"
        : meta.status === "done"
          ? "Done"
          : null;
  const fields = [
    ["Authors", authors],
    [
      "Published",
      typeof meta.year === "number" && Number.isInteger(meta.year)
        ? String(meta.year)
        : text(meta.year),
    ],
    ["Publisher", text(meta.publisher)],
    ["ISBN", isbn],
    ["Citation key", text(meta.cite_key)],
    ["Reading status", status],
    [
      "Rating",
      typeof meta.rating === "number" &&
      Number.isInteger(meta.rating) &&
      meta.rating >= 1 &&
      meta.rating <= 5
        ? `${meta.rating} / 5`
        : null,
    ],
  ].filter(([, value]) => value);

  if (fields.length === 0) return null;

  return (
    <section aria-label="Book details" className="mb-3">
      <dl className="grid gap-y-2 text-[13px]">
        {fields.map(([label, value]) => (
          <div
            key={label}
            className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4"
          >
            <dt className="text-mute">{label}</dt>
            <dd className="min-w-0 break-words text-ink-2">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
