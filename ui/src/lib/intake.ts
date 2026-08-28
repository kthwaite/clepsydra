// Client-side mirror of the backend's new-page path rules, used by the INTAKE
// modal: ADR 0002 canonical filenames (`<yyyymmdd>.<title-slug>.<shortid>.md`,
// see src/vault/page_filename.rs) projected into the metadata folder layout
// (`<kind-folder>/<project>/…`, see src/vault/projection.rs / ADR 0001).

import type { Kind } from "#/lib/kind";

/** Canonical top-level folder per kind — mirrors `Kind::canonical_folder` in src/vault/kind.rs. */
export const KIND_FOLDER: Record<Kind, string> = {
  NOTE: "notes",
  PROJECT: "projects",
  JOURNAL: "journals",
  TODO: "todos",
  QUOTE: "quotes",
  BOOK: "books",
  CAPTURE: "captures",
  CODE: "code",
  PERSON: "people",
  TASK: "tasks",
  CYCLE: "cycles",
  RECIPE: "recipes",
  MEETING: "meetings",
  ONE_ON_ONE: "one-on-ones",
  ARCHIVE: "archive",
  AI_CONVERSATION: "conversations",
  AI_JOURNAL: "ai-journals",
};

const SLUG_MAX = 40;

/** Mirrors `slugify_title` in src/vault/path.rs: ASCII alphanumerics survive,
 * every other run collapses to a single dash, trimmed, capped at `maxLen`. */
export function slugifyTitle(title: string, maxLen = SLUG_MAX): string {
  const lower = title.normalize("NFC").toLowerCase();
  let slug = "";
  let prevDash = false;
  for (const ch of lower) {
    if (/[a-z0-9]/.test(ch) && ch.charCodeAt(0) < 128) {
      slug += ch;
      prevDash = false;
    } else if (!prevDash) {
      slug += "-";
      prevDash = true;
    }
  }
  const out = slug
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/, "");
  return out || "untitled";
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** 8-char base62 id — counterpart of `generate_short_id` in src/vault/block_id.rs. */
export function generateShortId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => BASE62[b % 62]).join("");
}

export interface IntakePathOpts {
  kind: Kind;
  project: string | null;
  title: string;
  shortId: string;
  now: Date;
}

/** Projected vault path for a freshly inscribed page:
 * `<kind-folder>/<project?>/<yyyymmdd>.<slug>.<shortid>.md`. The date prefix
 * uses UTC, matching the backend's `chrono::Utc` filename stamps. */
export function intakePath({
  kind,
  project,
  title,
  shortId,
  now,
}: IntakePathOpts): string {
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const filename = `${date}.${slugifyTitle(title)}.${shortId}.md`;
  const sub = project?.trim().replace(/^\/+|\/+$/g, "");
  return [KIND_FOLDER[kind], sub || null, filename].filter(Boolean).join("/");
}
