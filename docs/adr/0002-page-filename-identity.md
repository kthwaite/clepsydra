# Page filenames are date-led, token-disambiguated identities

## Context

Pages were named directly from their title (`VaultPath::from_title` →
`notes/My Note.md`), so basenames could collide, with `affordances.md`
prescribing zero-padded `-N` disambiguation. ADR 0001 makes a page's folder a
*projection* of its metadata, freely moving files between folders — which is
only collision-safe if basenames are globally unique. We already have a compact
id philosophy in `BlockId` (base62, time-sorted).

## Decision

Authored Page (`.md`) filenames follow:

    <yyyymmdd>.<title-slug>.<shortid>.md      e.g. 20260531.redesign-retro.3kF9a2bQ.md

- **`yyyymmdd`** — the page's `created_at` date; leads the name for lexicographic
  date sorting; stable for the file's life.
- **`title-slug`** — a lowercased, hyphenated, truncated snapshot of the title
  *taken at creation*. A human/autocomplete hint only; **never re-synced** when
  the title is later edited (title edits touch frontmatter alone, so they cost no
  file move and no link rewrite).
- **`shortid`** — an 8-char base62 token, consistent with `BlockId`, generated
  once and stable; guarantees global basename uniqueness.

Consequently **the path is non-identifying** — identity is the frontmatter UUID,
the filename is the stable human handle. Imported documents and attachments are
out of scope and keep the descriptive `YYYY[-MM[-DD]].[TOOL-TOPIC-DESC][-N].EXT`
pattern.

## Considered options

- **Adjective-animal token** (`brave-otter`) — rejected: memorability is
  redundant once date + title-slug supply human context, and base62 is
  consistent with `BlockId`. Trivially swappable if desired.

## Consequences

- Basename uniqueness is *structural*, so projection moves (ADR 0001) can never
  collide — this supersedes both the `-N` scheme for pages and the need for any
  reject/auto-suffix collision policy on move.
- A one-time migration renames existing pages to the new form, with vault-wide
  link rewriting via the `MovePage` planner.
- Filenames contain interior dots; only the trailing `.md` is the extension —
  stem/extension handling must strip just the final `.md`.
