// Note "kind" — a first-class taxonomy driving the coloured pips across
// GAZETTEER, CONSTELLATION, SHEAF, and link previews.
//
// The kind set mirrors the backend (authoritative) enum exactly. Resolution is:
//   explicit kind  →  frontmatter `type`/`kind`  →  top-level folder  →  NOTE
// When the backend supplies a real `kind`, pass it as `kind` and it wins; the
// folder/frontmatter heuristics remain only as the fallback for callers that
// lack a backend kind.

import type { components } from "#/api/schema";

/** The kind vocabulary, generated from the backend's OpenAPI `Kind` enum
 * (src/vault/kind.rs via `bun run openapi`). The backend stays authoritative:
 * adding/removing a variant there changes this union on regeneration. */
export type Kind = components["schemas"]["Kind"];

/** Runtime list of kinds, in display order for kind pickers. `satisfies`
 * rejects tokens the backend doesn't know; the `Exclude` assertion below fails
 * typecheck if a backend kind is missing here, so the two cannot drift. */
export const KINDS = [
  "NOTE",
  "PROJECT",
  "JOURNAL",
  "TODO",
  "QUOTE",
  "BOOK",
  "CAPTURE",
  "CODE",
  "PERSON",
  "TASK",
  "CYCLE",
  "RECIPE",
  "AI_CONVERSATION",
] as const satisfies readonly Kind[];

type MissingFromKinds = Exclude<Kind, (typeof KINDS)[number]>;
const _kindsAreExhaustive: [MissingFromKinds] extends [never]
  ? true
  : MissingFromKinds = true;
void _kindsAreExhaustive;

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
  TODO: { label: "TODO", color: "var(--warn)" },
  JOURNAL: { label: "JOURNAL", color: "var(--cool)" },
  QUOTE: { label: "QUOTE", color: "var(--warn)" },
  BOOK: { label: "BOOK", color: "var(--accent-deep)" },
  CODE: { label: "CODE", color: "var(--ink)" },
  PERSON: { label: "PERSON", color: "var(--cool)" },
  CAPTURE: { label: "CAPTURE", color: "var(--cool)" },
  NOTE: { label: "NOTE", color: "var(--ink-mute)" },
  TASK: { label: "TASK", color: "var(--hot)" },
  CYCLE: { label: "CYCLE", color: "var(--ink-2)" },
  RECIPE: { label: "RECIPE", color: "var(--accent-deep)" },
  AI_CONVERSATION: { label: "AI CONVERSATION", color: "var(--cool)" },
};

export const kindLabel = (kind: Kind): string => KIND_META[kind].label;
export const kindColorVar = (kind: Kind): string => KIND_META[kind].color;

// Top-level folder → kind. Keys are lowercased folder names; several synonyms
// map to the same kind.
const FOLDER_KIND: Record<string, Kind> = {
  journals: "JOURNAL",
  journal: "JOURNAL",
  daily: "JOURNAL",
  dailies: "JOURNAL",
  diary: "JOURNAL",
  todos: "TODO",
  todo: "TODO",
  tasks: "TASK",
  task: "TASK",
  cycles: "CYCLE",
  cycle: "CYCLE",
  sprints: "CYCLE",
  sprint: "CYCLE",
  notes: "NOTE",
  note: "NOTE",
  projects: "PROJECT",
  project: "PROJECT",
  quotes: "QUOTE",
  quote: "QUOTE",
  books: "BOOK",
  book: "BOOK",
  reading: "BOOK",
  library: "BOOK",
  captures: "CAPTURE",
  capture: "CAPTURE",
  inbox: "CAPTURE",
  clippings: "CAPTURE",
  code: "CODE",
  snippets: "CODE",
  people: "PERSON",
  persons: "PERSON",
  person: "PERSON",
  contacts: "PERSON",
  recipes: "RECIPE",
  recipe: "RECIPE",
  conversations: "AI_CONVERSATION",
  conversation: "AI_CONVERSATION",
  chats: "AI_CONVERSATION",
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
const TYPE_LINE_RE = /^(?:type|kind)\s*:\s*["']?([A-Za-z_]+)["']?\s*$/im;

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
