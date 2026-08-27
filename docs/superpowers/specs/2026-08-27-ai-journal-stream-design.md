# AI Journal Stream Design

Task: TSK-0075 — Separate AI-assistant journaling from the human journal.

## Goal

AI assistants currently append to the human's daily journal through `vault_journal_capture`. An agent entry is byte-identical to a human entry. This feature gives assistants their own daily journal stream so the human journal holds only what the human wrote or explicitly asked to have written.

The AI journal is a first-class dated stream: a new `AI_JOURNAL` Kind with one page per day, full navigation parity with the human journal, and attributed entries.

## Decisions

These were settled in the design interview:

1. **Separation model:** a new `AI_JOURNAL` Kind with its own folder and daily pages. Not AI_CONVERSATION-backed; not attributed sections inside the human day page.
2. **Granularity:** one shared stream for all agents. Attribution is per entry via an optional free-text `author` label. No per-agent pages, no agent identity model.
3. **Navigation:** full parity — the AI journal gets its own day navigation, FASTI timeline, command palette entry, launcher and Atrium entries, plus cross-links between the two day pages.
4. **Capture routing:** split tools. `vault_journal_capture` keeps writing to the human journal and is reserved for captures the user explicitly requests. A new `vault_ai_journal_capture` writes to the AI journal and is where all agent-initiated notes go.

## Scope

This feature will:

- add `Kind::AiJournal` (wire token `AI_JOURNAL`, folder `ai-journals/`, computed tag `ai_journal`);
- extend `journal_date` derivation to the `ai-journals/` folder so both streams share the indexed date column;
- add kind predicates to every existing journal query so the two streams never mix;
- add a mirrored API surface at `/api/vault/ai-journal` with an optional per-entry `author`;
- add the `vault_ai_journal_capture` MCP tool and re-scope `vault_journal_capture`'s contract in prose;
- give the AI journal full UI parity (meta rail with day nav and FASTI, palette, launcher, Atrium) plus bidirectional day-page cross-links;
- exclude AI journals from the Agenda and from carried-forward todos;
- lock the `AI_JOURNAL` kind against reassignment, and reject project assignment on both journal kinds (fixing a latent data-loss bug);
- update documentation and the vault skill.

This feature will not:

- migrate existing entries — AI-written entries already in the human journal are indistinguishable and stay put;
- add per-agent pages or any agent identity beyond the free-text `author` label;
- prevent generic page-edit tools (`vault_edit_page`, `vault_append_page`) from touching the human journal — that stays a prose-level convention, like the `ai-generated` tag;
- include AI journals in Agenda, carried-forward, or the human capture surfaces (⌘⇧D aside, `clep todo`, nvim);
- add nvim or CLI support for the AI journal;
- add carried-forward todos to the AI journal's today response.

## Naming

| Concept | Value |
| --- | --- |
| Enum variant | `Kind::AiJournal` |
| Wire token | `AI_JOURNAL` |
| Canonical folder | `ai-journals/` (folder synonyms: `ai-journals`, `ai-journal`) |
| Computed tag | `ai_journal` |
| API mount | `/api/vault/ai-journal` |
| MCP tool | `vault_ai_journal_capture` |
| UI label | `AI Journal` |

## Domain model

### Kind

`Kind::AiJournal` joins the enum in `src/vault/kind.rs` with all five arms: `canonical_folder` (`ai-journals`), `computed_tag` (`ai_journal`), `as_str` (`AI_JOURNAL`, with the `#[schema(rename)]` the multi-word tokens use), `from_token`, and `from_folder`.

Server-created AI journal pages follow the human journal convention: no declared `type =` in frontmatter; the kind is inferred from the folder. Title is the `YYYY-MM-DD` date. Filenames use the canonical `page_filename` scheme: `ai-journals/<yyyymmdd>.<YYYY-MM-DD>.<shortid>.md`.

### journal_date

`extract_journal_date` (`src/vault/index.rs`) is parameterized over the stream prefix: it accepts `journals/` and `ai-journals/`, both canonical and legacy (`<prefix>/YYYY-MM-DD.md`) shapes. Both streams populate the same `pages.journal_date` column.

Because the column is shared, every consumer that means "the human journal" gains a `kind = 'JOURNAL'` predicate:

- `find_journal_path` (`src/api/journal.rs`) takes a kind parameter; the today/date/range/recent handlers pass `JOURNAL`, the new AI handlers pass `AI_JOURNAL`;
- the carried-forward SQL in `get_today`;
- the Agenda's `p.journal_date = today` clause and its "Today" classification (`src/api/agenda.rs`).

`JOURNAL_ENSURE_LOCK` is shared by both streams; `ensure_journal` is parameterized by kind so one page per date per stream is guaranteed.

### Kind rules

`validate_kind_assignment` (`src/api/pages.rs`) extends its lock: a page whose current kind is `AI_JOURNAL` cannot be reassigned to another kind, mirroring the existing `JOURNAL` rule.

Project assignment on a page of either journal kind is rejected as a client error. Today, assigning a project to a `JOURNAL` page relocates it to `journals/<project>/…`, at which point `extract_journal_date` returns `None` and the page silently vanishes from every journal query. Journals are dateline streams, not project pages; the rejection closes the hole for both kinds. The UI mirrors the rule the same way the kind lock is mirrored (disabled control with a reason).

## API

New module `src/api/ai_journal.rs`, mounted at `/api/vault/ai-journal`, mirroring the journal routes:

| Route | Behavior |
| --- | --- |
| `GET /today` | 404 if absent. Returns `{ page }` — no carried-forward field. |
| `POST /today` | Get-or-create; 201 created, 200 existing. |
| `POST /today/capture` | Appends an entry; 409 on an encrypted page. |
| `GET /{date}` | Strict `YYYY-MM-DD`. |
| `GET /range?from&to` | Summaries by `journal_date`, AI kind only. |
| `GET /recent?days=7` | Same shape as journal recent. |

"Today" is the server clock, exactly as for the human journal.

### Capture and attribution

The capture body is `{ content, author? }`. `author` is a free-text label naming the writing agent (for example `claude-code`). It is trimmed and must be a single line of 1–64 Unicode scalars; anything else is a 400.

Formatting extends the existing `format_capture_entry` behavior:

- plain prose with an author: `- HH:MM — [author] content`;
- plain prose without an author: `- HH:MM — content` (unchanged shape);
- block constructs (lists, tasks, headings, quotes, fences) pass through verbatim, unattributed, exactly as today.

Implementation parameterizes the existing ensure/lookup/capture machinery in `src/api/journal.rs` by kind rather than duplicating it.

The OpenAPI spec is regenerated so `ui/src/api/schema.d.ts` picks up the new kind and routes.

## MCP

New tool `vault_ai_journal_capture` with params `{ content, author? }`, calling `POST /api/vault/ai-journal/today/capture`. Its description states: this is where agent-initiated notes, observations, and work logs go; the `ai-generated` tag is not required (the stream is AI-authored by definition).

`vault_journal_capture` keeps its name and behavior. Its description and `MCP_INSTRUCTIONS` change to state the contract: it writes to the user's own journal and is used only when the user explicitly asks for a journal capture; agent-initiated notes use `vault_ai_journal_capture`. The stale `journals/YYYY-MM-DD.md` path in its description is corrected to the canonical scheme while we are there.

Prose sites with no compile guard, updated by hand: `KIND_TOKENS` and the doc-comment kind lists in `src/mcp/server.rs`. The existing description/instruction assertion tests extend to cover the new sentences.

## UI

### Kind mirrors

`KINDS`, `KIND_META` (label `AI Journal`, a distinct colour), and the folder maps in `ui/src/lib/kind.ts` and `ui/src/lib/intake.ts` gain the new kind; the exhaustiveness assertions make typecheck the guard.

### Meta rail: parameterized JournalMeta

`JournalMeta` is refactored over a stream config — labels, API hooks, `pathForDate`, draft-path scheme — and instantiated twice. Both instances provide: prev/Today/next day navigation that repoints the hosting tab, the 14-row FASTI timeline over that stream's `recent(30)`, day-of-year, and written/unwritten state.

Cross-links, both directions: the human day page's rail gains an `AI Journal` row showing the same date's written state and opening it; the AI day page's rail links back to the human day page. Written state comes from the opposite stream's existing endpoints (a `GET /{date}` 404 means unwritten).

`kindPresentation` registers `AI_JOURNAL` with the editor body presentation, the AI instance of the meta rail, and the day-label read-only title. The page stays human-editable, like any journal page.

### Entry points

- New API hooks module mirroring `ui/src/api/journal.ts` (today, ensure, recent, editor options) with the draft-then-create dance; the client draft path is `ai-journals/YYYY-MM-DD.md`, revealed to the canonical path once the server creates the page.
- Command palette: `journal.ai.today` — "Today's AI journal". No AI capture command; the ⌘⇧D aside stays human-only.
- FolioLauncher: an "AI journal" entry beside "Today's journal".
- Atrium: a secondary entry under the journal hero CTA opening today's AI journal.

### Graph surfaces

Constellation's "hide daily" filter covers the `ai-journals/` path prefix. ForceGraph assigns the kind a distinct glyph (for example a dashed ring).

Search (`kind:AI_JOURNAL`, `tag:ai_journal`) and the Gazetteer kind facet work without changes once the kind exists.

## Documentation

- `ui/src/docs/content/tasks-agenda-journals-and-board.mdx`: the two streams, their separation, and the Agenda exclusion.
- `ui/src/docs/content/mcp.mdx`: the split capture contract.
- `.claude/skills/vault/SKILL.md`: capture-intent routing — user-requested journal captures vs agent-initiated notes.

## Testing

Rust:

- kind round-trip tests (token, folder, computed tag) including the OpenAPI contract test;
- `extract_journal_date` over `ai-journals/` canonical and legacy shapes, and non-top-level rejection;
- endpoint mirror tests: ensure idempotency, capture formatting with and without `author`, author validation, encrypted 409, date/range/recent, stream isolation (a human page never appears in AI queries and vice versa);
- kind lock and project-rejection tests for both journal kinds;
- Agenda and carried-forward exclusion tests;
- MCP: tool registry, capture round-trip, description/instruction prose assertions.

UI:

- typecheck as the mirror guard;
- stream-parameterized JournalMeta: day nav, FASTI, cross-link rows with written state;
- draft-then-create dance for the AI stream;
- palette command and launcher entry presence.

Gates: `cargo test`, `cargo clippy`, `cargo fmt` (touched files only — the repo is not fmt-clean), `bun run typecheck`, `bun run lint` (touched files), `bun run test`.
