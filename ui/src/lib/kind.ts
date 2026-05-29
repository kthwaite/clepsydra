// Note "kind" — a first-class taxonomy driving the coloured pips across
// GAZETTEER, CONSTELLATION, SHEAF, and link previews.
//
// There is no backend `kind` field yet. Near-term resolution is:
//   explicit kind  →  frontmatter `type`/`kind`  →  top-level folder  →  NOTE
// The shape is forward-compatible: when the backend exposes a real `kind`,
// pass it as `kind` and it wins. List endpoints currently expose only `path`,
// so list-level callers use `resolveKindFromPath`.

export const KINDS = [
  "FRAGMENT",
  "DAILY",
  "TASK",
  "QUOTE",
  "BOOK",
  "PROJECT",
  "CAPTURE",
  "CODE",
  "PERSON",
  "NOTE",
] as const;

export type Kind = (typeof KINDS)[number];

const KIND_SET = new Set<string>(KINDS);

export type KindMeta = {
  label: string;
  /** CSS custom-property reference for the pip / accent colour. */
  color: string;
};

// Colour assignment leans on the Vessel signal tokens: --accent (primary),
// --cool (secondary), --warn (attention), with neutral ink ramps for the rest.
export const KIND_META: Record<Kind, KindMeta> = {
  PROJECT: { label: "PROJECT", color: "var(--accent)" },
  TASK: { label: "TASK", color: "var(--warn)" },
  DAILY: { label: "DAILY", color: "var(--cool)" },
  FRAGMENT: { label: "FRAGMENT", color: "var(--ink-2)" },
  QUOTE: { label: "QUOTE", color: "var(--warn)" },
  BOOK: { label: "BOOK", color: "var(--accent-deep)" },
  CODE: { label: "CODE", color: "var(--ink)" },
  PERSON: { label: "PERSON", color: "var(--cool)" },
  CAPTURE: { label: "CAPTURE", color: "var(--cool)" },
  NOTE: { label: "NOTE", color: "var(--ink-mute)" },
};

export const kindLabel = (kind: Kind): string => KIND_META[kind].label;
export const kindColorVar = (kind: Kind): string => KIND_META[kind].color;

// Top-level folder → kind. Keys are lowercased folder names; several synonyms
// map to the same kind.
const FOLDER_KIND: Record<string, Kind> = {
  daily: "DAILY",
  dailies: "DAILY",
  journal: "DAILY",
  journals: "DAILY",
  diary: "DAILY",
  projects: "PROJECT",
  project: "PROJECT",
  tasks: "TASK",
  task: "TASK",
  todo: "TASK",
  todos: "TASK",
  quotes: "QUOTE",
  quote: "QUOTE",
  books: "BOOK",
  book: "BOOK",
  reading: "BOOK",
  library: "BOOK",
  code: "CODE",
  snippets: "CODE",
  people: "PERSON",
  persons: "PERSON",
  contacts: "PERSON",
  captures: "CAPTURE",
  capture: "CAPTURE",
  inbox: "CAPTURE",
  clippings: "CAPTURE",
  fragments: "FRAGMENT",
  fragment: "FRAGMENT",
  zettel: "FRAGMENT",
};

export function resolveKindFromPath(path: string): Kind {
  const trimmed = path.replace(/^\/+/, "");
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return "NOTE";
  const top = trimmed.slice(0, slash).toLowerCase();
  return FOLDER_KIND[top] ?? "NOTE";
}

function normalizeKind(value: string | undefined | null): Kind | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  return KIND_SET.has(upper) ? (upper as Kind) : null;
}

const FRONTMATTER_RE = /^\s*---\r?\n([\s\S]*?)\r?\n---/;
const TYPE_LINE_RE = /^(?:type|kind)\s*:\s*["']?([A-Za-z]+)["']?\s*$/im;

export function parseFrontmatterKind(
  body: string | undefined | null,
): Kind | null {
  if (!body) return null;
  const fm = body.match(FRONTMATTER_RE);
  if (!fm) return null;
  const line = fm[1].match(TYPE_LINE_RE);
  return normalizeKind(line?.[1]);
}

export type KindSource = {
  path: string;
  /** Explicit kind (e.g. a future backend field). Highest priority. */
  kind?: string | null;
  /** Raw markdown body, parsed for leading frontmatter `type`/`kind`. */
  body?: string | null;
};

export function resolveKind(src: KindSource): Kind {
  return (
    normalizeKind(src.kind) ??
    parseFrontmatterKind(src.body) ??
    resolveKindFromPath(src.path)
  );
}
