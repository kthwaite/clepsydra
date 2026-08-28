# ONE_ON_ONE folds into MEETING; attendee rail refinements (TSK-0105, TSK-0106)

Branch `feature/meeting-one-on-one-tag` in `.worktrees/meeting-1to1`, off `develop`.

## Decisions (2026-08-28, Kit)

- **ONE_ON_ONE is no longer a Kind.** A 1:1 is a MEETING carrying the user tag
  `1:1`. The Kind vocabulary (Rust enum, OpenAPI `Kind` schema, UI `KINDS`,
  MCP `KIND_TOKENS`, docs, the `vault` skill) loses the token.
- **Legacy input keeps working, leniently.** `type = "ONE_ON_ONE"` (and the
  spellings `ONE-ON-ONE`, `ONEONONE`, `1:1`, `1-1`, `1ON1`) parse as MEETING;
  folders `one-on-ones/`, `one-on-one/`, `one-to-ones/`, `1-1s/`, `1on1s/`,
  `121s/` … infer MEETING. Nothing is written back as ONE_ON_ONE. The vault
  has zero ONE_ON_ONE/MEETING/PERSON pages today, so there is no data migration.
- **Attendee cardinality is gone.** `attendance::Cardinality`, `validate`'s
  ceiling, `TooManyAttendees`, and `is_incomplete` (the "1:1 names nobody"
  doctor report) are removed. `attendance::validate` still rejects malformed
  shape, empty entries, and duplicates. MEETING is the only kind with attendees.
- **Tag `1:1` is manual.** The Meeting rail gets a one-click "1:1" toggle that
  adds/removes the tag through the Folio editor's tag state (same path as the
  header TagInput); the Inscribe modal offers a "1:1" checkbox when Kind is
  MEETING. No computed/derived tag.
- **Search gains `attendees:`** — `attendees:1`, `attendees:>1`,
  `attendees:>=3`, `attendees:<3`, `attendees:<=3`, `attendees:=2`. It counts
  `page_properties` rows with key `attendees` (one row per entry; a bare string
  is one row); a page without the property counts as 0. Also: a field value
  word may absorb byte-adjacent `:word` continuations so `tag:1:1` and
  `tag:model:gpt-5.6-sol` parse unquoted (quoted values already work).
- **Rail refinements (TSK-0105):** person field becomes a combobox over PERSON
  pages with a Create-new-person row; the × dismiss becomes an icon-sized ghost
  control; the "a 1:1 names one person" caption goes; each attendee name is a
  link to the person page (missing page → the editor's missing-wikilink
  affordance / Create); person backlinks verified by an API test.
- No DTO shape changes beyond the `Kind` enum shrinking; `schema.d.ts` is
  regenerated from the new server before UI work starts.

## Task A — Rust core (subagent, first)

Files: `src/vault/kind.rs`, `src/vault/attendance.rs`, `src/vault/meeting.rs`,
`src/api/pages.rs`, `src/api/properties.rs`, `src/api/openapi.rs`,
`src/doctor.rs`, `src/mcp/server.rs`, `src/vault/config.rs` (comment only),
`src/vault/search/{query,sql}.rs`, `tests/api_meetings_test.rs`,
`tests/openapi_contract.rs`, search tests, `ui/src/docs/content/{pages-and-authoring,getting-started,links-search-graph-and-repair,mcp}.mdx`,
`.claude/skills/vault/SKILL.md`.

TDD order — RED first for each group:

1. **Kind vocabulary.** Tests: `Kind::from_token("ONE_ON_ONE") == Some(Kind::Meeting)`
   (and the other spellings); `from_folder("one-on-ones") == (Meeting, true)`;
   the OpenAPI vocabulary test (`kind_schema_is_the_full_uppercase_vocabulary`)
   and `tests/openapi_contract.rs` no longer list ONE_ON_ONE; `all()`/round-trip
   tests updated. Then remove `Kind::OneOnOne` everywhere (`as_str`,
   `canonical_folder`, `computed_tag`, serde/utoipa), folding legacy tokens
   and folders into MEETING with a comment naming the 2026-08-28 decision.
2. **Attendance.** Tests: a MEETING with three attendees validates; the shape,
   empty-entry, and duplicate errors still fire; `cardinality`/`Cardinality`/
   `TooManyAttendees`/`is_incomplete` are gone (tests deleted with them).
   Update `src/doctor.rs` `check_attendance` (drop the "incomplete" branch),
   `src/api/pages.rs` (create scaffold match, assign validation comment, doc
   comments), `src/api/properties.rs` comment, `src/vault/meeting.rs`
   (`records_occurrence` = MEETING only).
3. **api_meetings_test.rs.** Rewrite the ONE_ON_ONE cardinality tests into:
   a MEETING accepts any number of attendees; `type = "ONE_ON_ONE"` on disk
   reads back as `kind: "MEETING"`; a page under `one-on-ones/` infers MEETING;
   a PERSON page's `/index/backlinks` lists the MEETING that names it
   (`property_ref`, `source_field: attendees`) — this is TSK-0105's
   verification item. Keep the occurred_at tests.
4. **Search.** Tests in `src/vault/search/query.rs`: `attendees:1`,
   `attendees:>=3`, `attendees:<3` parse to a new `SearchField::Attendees`
   with a normalized value; `attendees:x`, `attendees:>`, `attendees:-1`
   → a diagnostic (`InvalidNumber` or reuse `EmptyValue`/`UnknownKind`-style
   kind — add `InvalidFieldValue` with code `invalid_field_value`); `tag:1:1`
   parses as field tag value `1:1`; `tag:1 :1` does not glue (whitespace).
   Tests in `sql.rs`/integration (`tests/` search suite — find the existing
   structured-search tests from TSK-0079 and extend them): pages with 0, 1, 3
   attendees; `attendees:1` returns only the one; `attendees:>1` the three;
   `attendees:0` the page without the property; `-attendees:0` the rest;
   `kind:meeting tag:"1:1"` composes. SQL:
   `((SELECT COUNT(*) FROM page_properties pp WHERE pp.page_id = p.id AND pp.key = 'attendees') <op> ?n)`.
5. **MCP + docs + skill.** `KIND_TOKENS` and the three doc comments in
   `src/mcp/server.rs` drop ONE_ON_ONE; `vault_search` description mentions
   `attendees:`. Docs: rewrite the "Record a meeting or a 1:1" section
   (MEETING + tag `1:1`; attendees any number; `attendees:` search examples);
   getting-started pip table drops "1:1"; links-search docs add
   `attendees:>1` and `tag:"1:1"`/`tag:1:1` examples; `mcp.mdx` if it lists
   kinds. `.claude/skills/vault/SKILL.md`: Kinds line, Attendees paragraph
   ("a MEETING names any number; a 1:1 is a MEETING tagged `1:1`").
6. Gates: `cargo test` (full), `cargo clippy --all-targets -- -D warnings`,
   `rustfmt --check` on touched files. Run `cd ui && bun run test src/docs`
   for the mdx smoke test.

## Task B — schema regen (main session, after A)

Scratch config in the scratchpad pointing at an empty temp vault; run the
worktree's server on port 3001 (`cargo run -- serve --port 3001` with cwd on
the scratch config); `bunx openapi-typescript http://localhost:3001/api/openapi.json -o src/api/schema.d.ts`
from the worktree's `ui/`; stop the server. Commit A + the schema together.

## Task C — UI (subagent, after B)

Files: `ui/src/lib/{kind,attendance,meeting,intake,kindPresentation}.ts(x)` and
their tests, `ui/src/components/codex/MeetingMeta.tsx` (+ test),
`ui/src/components/codex/Folio.tsx` (pass `tags`/`onTagsChange` into
`metaExtras`), `ui/src/components/codex/InscribeModal.tsx` (+ test), a new
`ui/src/components/codex/PersonCombo.tsx` (+ test).

TDD order:

1. **Vocabulary.** `KINDS` drops ONE_ON_ONE; `KIND_META` entry removed; folder
   map entries (`one-on-ones`, `one-on-one`, `one-to-ones`, `one-to-one`,
   `1-1s`, `1-1`, `1on1s`, …) → `"MEETING"`; `intake.ts` `KIND_FOLDER` entry
   removed; `kindPresentation.tsx` registry entry removed; `meeting.ts`
   `recordsOccurrence` = MEETING only; `attendance.ts`: `hasAttendees(kind)`
   = MEETING only, `canAddAttendee` → always true for MEETING (drop
   Cardinality). Tests updated in `kind.test.ts`, `attendance.test.ts`,
   `meeting.test.ts`, `intake.test.ts`, `kindPresentation.test.tsx`.
2. **KindMetaExtrasProps** gains `tags: string[]` and
   `onTagsChange(next: string[]) => void`; `Folio.tsx` passes the editor's
   `editableTags`/`editor.setTags` (the same values the header gets).
   JournalMeta ignores them.
3. **PersonCombo** (react-aria ComboBox, modelled on `ProjectCombo.tsx` +
   `WikilinkCombobox.tsx`): options = PERSON pages (title + aliases) from the
   content index (`useContentIndex` with kind PERSON — verify the hook's
   filter; otherwise `usePages()` filtered client-side); typing a name that
   matches no page shows a "Create “Name”" row; selecting it calls
   `useCreatePage` with `intakePath({ kind: "PERSON", title })`, `kind:
   "PERSON"`, then resolves to the new page; Enter on an exact match selects
   it. Tests: lists people, filters by prefix, offers Create for a new name,
   selecting a person calls `onPick(name)`.
4. **MeetingMeta.tsx.** Replace the input+Add with PersonCombo; attendee rows
   render the name as a link (`Link` to the person page path when it exists;
   otherwise the name with a small "create" affordance that creates the PERSON
   page); the × becomes an icon-sized ghost button (`aria-label="remove …"`);
   delete the "a 1:1 names one person" caption; add the **1:1** toggle
   (`aria-pressed`, adds/removes tag `1:1` via `onTagsChange`). Tests in
   `MeetingMeta.test.tsx`: combobox present, remove works, no caption, toggle
   adds/removes the tag, attendee renders as a link.
5. **InscribeModal.** When Kind is MEETING, a "1:1" checkbox adds the tag to
   the tags field (remove on uncheck). Test.
6. Gates from `ui/`: `bun run typecheck`, `bunx biome check` on touched files,
   `bun run test src/lib src/components/codex`, then full `bun run test`.

## Task D — close-out (main session)

Full gates in the worktree (cargo + ui), commit per task, merge into develop
(branch verified inline), remove the worktree, `bun run build` + `cargo
install --path .`, seal TSK-0105/0106 with notes, Stray Thoughts, memory.
