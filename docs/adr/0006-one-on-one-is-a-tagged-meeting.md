# A 1:1 is a MEETING tagged `1:1`, not a Kind

ONE_ON_ONE shipped as a Kind of its own with one distinguishing rule: at most one
attendee, enforced on every write. Everything else — `occurred_at`, `attendees`, the
MeetingMeta rail, the scaffold, the docs section — was MEETING's, shared through the UI
presentation registry. The Kind cost a token in every vocabulary (Rust enum, OpenAPI
`Kind`, UI `KINDS`, MCP `KIND_TOKENS`, docs, the vault skill), a canonical folder,
folder-inference aliases, a computed tag, a `clep doctor` branch, and per-kind UI work in
the Inscribe modal and rails; and the ceiling itself was the wrong shape, since a "1:1"
that later gains a third person is simply a meeting. We decided (2026-08-28): ONE_ON_ONE
is retired. A 1:1 is a MEETING page carrying the ordinary user tag `1:1`, set by hand — a
one-click toggle on the Meeting rail and a checkbox in the Inscribe modal, never derived.
MEETING is the only kind with attendees and it names any number of people; `attendees`
validation keeps only shape (a readable wikilink list, no empty or duplicate entries).
Structured search gains `attendees:` with a count comparison (`attendees:1`,
`attendees:>1`, `attendees:>=3`, …) over `page_properties` rows, and unquoted field values
absorb byte-adjacent `:word` continuations so `tag:1:1` parses.

## Consequences

- Legacy input is read leniently and never written back: `type = "ONE_ON_ONE"` and the
  spellings it accepted (`1:1`, `1-1`, `1ON1`, …) parse as MEETING; folders
  `one-on-ones/`, `1-1s/`, `121/` and the rest infer MEETING. The vault held no
  ONE_ON_ONE pages when this landed, so there was no data migration.
- "Find my 1:1s" is `kind:meeting tag:1:1`; "meetings with exactly one person" is
  `attendees:1 kind:meeting`. The two are no longer the same question, by design.
- `clep doctor` no longer reports "unnamed 1:1s"; an empty attendee list on any meeting
  is an unfinished note, not breakage.
- The `Kind` OpenAPI enum shrank; `ui/src/api/schema.d.ts` was regenerated in the same
  change. Clients that sent `ONE_ON_ONE` still succeed (it decodes as MEETING).
