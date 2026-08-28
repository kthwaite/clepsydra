// Note "kind" — a first-class taxonomy driving the kind markers (a coloured
// lucide glyph, see KindIcon) across GAZETTEER, SHEAF, the Folio rails, and
// link previews, plus CONSTELLATION's node shapes.
//
// The kind set mirrors the backend (authoritative) enum exactly. Resolution is:
//   explicit kind  →  frontmatter `type`/`kind`  →  top-level folder  →  NOTE
// When the backend supplies a real `kind`, pass it as `kind` and it wins; the
// folder/frontmatter heuristics remain only as the fallback for callers that
// lack a backend kind.

import {
  Archive,
  BookOpen,
  Bot,
  Calendar,
  Code,
  Compass,
  CookingPot,
  FileText,
  Inbox,
  ListChecks,
  type LucideIcon,
  MessagesSquare,
  Quote,
  Repeat,
  SquareCheckBig,
  User,
  Users,
} from "lucide-react";
import type { components } from "#/api/schema";

/** The kind vocabulary, generated from the backend's OpenAPI `Kind` enum
 * (src/vault/kind.rs via `bun run openapi`). The backend stays authoritative:
 * adding/removing a variant there changes this union on regeneration. */
export type Kind = components["schemas"]["Kind"];

/** Runtime list of every backend-compatible kind, in display order. `satisfies`
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
  "MEETING",
  "ARCHIVE",
  "AI_CONVERSATION",
  "AI_JOURNAL",
] as const satisfies readonly Kind[];

type MissingFromKinds = Exclude<Kind, (typeof KINDS)[number]>;
const _kindsAreExhaustive: [MissingFromKinds] extends [never]
  ? true
  : MissingFromKinds = true;
void _kindsAreExhaustive;

export const ASSIGNABLE_KINDS = KINDS.filter(
  (kind): kind is Exclude<Kind, "QUOTE"> => kind !== "QUOTE",
);

const KIND_SET = new Set<string>(KINDS);

export type KindMeta = {
  label: string;
  /** CSS custom-property reference for the marker / accent colour. */
  color: string;
  /** Lucide glyph denoting the kind. Distinct per kind: the icon carries the
   * kind on its own where colour alone would be ambiguous. */
  icon: LucideIcon;
};

// Colour assignment leans on the Vessel signal tokens: --accent (primary),
// --cool (secondary), --warn (attention), with neutral ink ramps for the rest.
export const KIND_META: Record<Kind, KindMeta> = {
  PROJECT: { label: "PROJECT", color: "var(--accent)", icon: Compass },
  TODO: { label: "TODO", color: "var(--warn)", icon: ListChecks },
  JOURNAL: { label: "JOURNAL", color: "var(--cool)", icon: Calendar },
  QUOTE: { label: "QUOTE", color: "var(--warn)", icon: Quote },
  BOOK: { label: "BOOK", color: "var(--accent-deep)", icon: BookOpen },
  CODE: { label: "CODE", color: "var(--ink)", icon: Code },
  PERSON: { label: "PERSON", color: "var(--cool)", icon: User },
  CAPTURE: { label: "CAPTURE", color: "var(--cool)", icon: Inbox },
  NOTE: { label: "NOTE", color: "var(--ink-mute)", icon: FileText },
  TASK: { label: "TASK", color: "var(--hot)", icon: SquareCheckBig },
  CYCLE: { label: "CYCLE", color: "var(--ink-2)", icon: Repeat },
  RECIPE: { label: "RECIPE", color: "var(--accent-deep)", icon: CookingPot },
  // Meetings are about people, so they take PERSON's cool hue. A 1:1 is a
  // MEETING tagged `1:1`, not a kind of its own.
  MEETING: { label: "MEETING", color: "var(--cool)", icon: Users },
  // Archived pages are inert captures of someone else's writing; a muted ink
  // hue keeps them legible without competing with authored material.
  ARCHIVE: { label: "ARCHIVE", color: "var(--ink-3)", icon: Archive },
  AI_CONVERSATION: {
    label: "AI CONVERSATION",
    color: "var(--cool)",
    icon: MessagesSquare,
  },
  // The assistants' own daily stream; deep accent separates it from the
  // human JOURNAL's cool calendar at a glance.
  AI_JOURNAL: { label: "AI JOURNAL", color: "var(--accent-deep)", icon: Bot },
};

export const kindLabel = (kind: Kind): string => KIND_META[kind].label;
export const kindColorVar = (kind: Kind): string => KIND_META[kind].color;
export const kindIcon = (kind: Kind): LucideIcon => KIND_META[kind].icon;

/** Alphabetical picker order — by display label, which is what the user
 * scans. */
export const sortKindsByLabel = <K extends Kind>(kinds: readonly K[]): K[] =>
  [...kinds].sort((a, b) => kindLabel(a).localeCompare(kindLabel(b)));

// Top-level folder → kind. Keys are lowercased folder names; several synonyms
// map to the same kind.
const FOLDER_KIND: Record<string, Kind> = {
  "ai-journals": "AI_JOURNAL",
  "ai-journal": "AI_JOURNAL",
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
  meetings: "MEETING",
  meeting: "MEETING",
  // Legacy 1:1 folders: a 1:1 is a MEETING tagged `1:1` (mirrors
  // Kind::from_folder in src/vault/kind.rs).
  "one-on-ones": "MEETING",
  "one-on-one": "MEETING",
  "one-to-ones": "MEETING",
  "one-to-one": "MEETING",
  "1-1s": "MEETING",
  "1-1": "MEETING",
  "1on1s": "MEETING",
  "1on1": "MEETING",
  "121s": "MEETING",
  "121": "MEETING",
  conversations: "AI_CONVERSATION",
  conversation: "AI_CONVERSATION",
  chats: "AI_CONVERSATION",
  archive: "ARCHIVE",
  archives: "ARCHIVE",
  archived: "ARCHIVE",
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
