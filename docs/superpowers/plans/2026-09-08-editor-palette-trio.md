# Editor + palette trio (2026-09-08)

Three independent, approved changes. Each is its own branch off `develop`,
executed TDD (red → green → refactor), merged into `develop` separately.
No Rust changes; gates are `cd ui && bun run typecheck && bun run lint && bun run test`.

## A. Date + time heading — branch `feature/datetime-heading`

Decisions (approved):
- Same `journal-time` element; new optional `date?: string` (`YYYY-MM-DD`).
- Markdown `## 2026-09-08 14:32`. Recognizer: `^(?:(\d{4}-\d{2}-\d{2}) )?(?:[01]\d|2[0-3]):[0-5]\d$` on an exact level-2 heading with one text child. Serializer writes `date + " " + time` when date is set.
- Render: `TIME / 2026-09-08 14:32`. **Journal rule:** when the page is a journal (JOURNAL or AI_JOURNAL) and `element.date` equals that journal's date, the date is not displayed (implicit). The markdown still carries the date. Aria label always includes the date when set.
- Triggers: slash command id `datetime`, label "Date & Time Heading", description "Insert today's date and the current local time as a section heading". Chord `editor.dateTimeHeading` = `{ key: "Enter", mod: true, alt: true, shift: true }`, label "Insert date + time heading", group Editor, scope editor.
- TOC (`folioToc.ts`): text = `date ? `${date} ${time}` : time`.

Tasks:
1. `schema/types.ts`: add `date?: string` to `JournalTimeElement`.
2. `convert/mdast-to-slate.ts` + `convert/__tests__/journalTime.test.ts`: recognise dated form; keep `## 2026-09-08` (date only) and `## 2026-9-8 14:32` as ordinary headings; round-trip both forms through `slateToMarkdown`.
3. `schema/elements/journalTime.tsx` `toMdast`: emit dated text. Test in same convert test.
4. `transforms/journalTime.ts`: `formatJournalDate(date)` → `YYYY-MM-DD` (local, use `localDateKey` from `#/lib/time` if it exists); `insertJournalTimeHeading(editor, now, startNewBatch, { withDate?: boolean })`. Tests in `transforms/__tests__/journalTime.test.ts`.
5. `transforms/blockConversions.ts`: `BlockConversion` gains `{ type: "journal-time"; withDate?: boolean }`; `SlateEditor.slashCommandToConversion("datetime")` → `{ type: "journal-time", withDate: true }`. Extend `__tests__/slashCommandToConversion.test.ts`.
6. `lib/shortcuts.ts`: `editor.dateTimeHeading` chord. `SlateEditor.tsx`: chord handler + slash entry (place right after `time`).
7. Journal context: new `editor/journalContext.ts(x)` exporting `JournalDateProvider` + `useJournalDate()` (returns `string | null`). `SlateEditor` gets prop `journalDate?: string | null` and wraps its body in the provider. `Folio.tsx` passes `journalDateFromPath(path) ?? aiJournalDateFromPath(path)` (both in `#/lib/journal`).
8. `schema/elements/journalTime.tsx` render: show date span unless `date === useJournalDate()`. Tests in `schema/__tests__/journalTimeElement.test.tsx` (dated render, hidden when matches journal date, shown when differs / no journal).
9. `components/codex/folioToc.ts` + test.
10. Docs: `ui/src/docs/content/editor-workflows.mdx` (chord paragraph near line 119, slash table near line 229).

## B. Escape trapping blocks + generalised block move — branch `feature/block-escape`

Decisions (approved):
- New `editor/transforms/blockEscape.ts`: `isTrappingBlock(node)` = registry descriptor kind `void-block` OR type `code-block` OR `table`. `escapeTrappingBlock(editor, "above" | "below"): boolean`.
  - Preconditions: collapsed selection; caret's top-level block is index 0 (above) / last (below); block is trapping; caret at the block's edge: void-block → always; code-block → no `"\n"` between block start and caret (above) / between caret and block end (below); table → caret in first row (above) / last row (below).
  - Effect: insert `makeParagraph({})` at `[0]` (above) or `[children.length]` (below), select its start. Return true.
- `SlateEditor.tsx` onKeyDown, after `vim.handleKeyDown` and before the wikilink arrow handling: `ArrowUp`/`ArrowLeft` → `escapeTrappingBlock(editor, "above")`; `ArrowDown`/`ArrowRight` → `"below"`. `ArrowLeft`/`ArrowRight` additionally require `Editor.isStart`/`Editor.isEnd` of the block (exact edge). On true: `preventDefault`, return. No modifiers held.
- `plugins/withOutliner.ts` `moveBlockUp/Down`: when `findListItem` returns null and the selection is collapsed, move the caret's top-level block (`[selection.anchor.path[0]]`) up/down one sibling, keeping the selection inside it. Bounds-checked no-op at the ends.
- Docs: `editor-workflows.mdx` — one paragraph: arrow keys step out above/below a code block, table, divider, embed, or time heading that opens or closes the note; ⌥↑/⌥↓ move any top-level block, not just list items.

Tasks:
1. `transforms/__tests__/blockEscape.test.ts` — build editors with the real plugin chain minus withReact (see `feedback_subagent_patterns` memory: `withHistory(withAutoformat(withOutliner(withSchema(createEditor()))))`; check how existing transform tests construct editors and copy that). Cases: code-block first line above, code-block second line above (no-op), code-block last line below (trailing paragraph rule may already exist — assert behaviour with a doc where the code block is last and note that `ensureTrailingParagraph` only runs on normalize; construct without normalising or accept the paragraph exists and escape is a no-op), table first/last row, thematic-break, journal-time, paragraph first (no-op), non-first code-block (no-op), expanded selection (no-op).
2. Implement `blockEscape.ts`.
3. Wire into `SlateEditor.tsx`.
4. `withOutliner` move generalisation + tests in the existing outliner test file.
5. Docs.

## C. ⌘K palette hover-steal + best-match — branch `feature/palette-hover-fix`

Decisions (approved):
- Cause: rows re-render under a stationary pointer on every keystroke; `mouseenter` fires on the row now beneath the pointer, and `onMouseEnter → setSel(i)` steals the highlight from row 0.
- Fix in `components/codex/CommandPalette.tsx`: drop `onMouseEnter`; add `onMouseMove` that compares `(clientX, clientY)` to a `lastPointerRef`; only when they differ does it `setSel(i)` and record the new coords. On query change (the existing `setSel(0)` site) also reset `lastPointerRef` to the current known coords (or null) so the next synthetic move under a stationary pointer is ignored — verify in the test that a `mousemove` with identical coords after a query change does NOT change `sel`, and one with different coords DOES.
- Best match: `rankCommands(commands, q)` pure helper in a new `components/codex/commandRanking.ts`: score = 0 exact title match (case-insensitive), 1 title starts with q, 2 any word of title starts with q, 3 substring in title or id; stable sort by score. Apply to `verbsMatch` and `tagsMatch` separately; `noteCommands` untouched (server order). Unit-test the helper.
- Component test `CommandPalette.test.tsx` with testing-library: render, type a query, fire `mouseMove` on a row with unchanged coords → highlight stays on the best match; fire with new coords → moves. Check how other codex tests mock the workspace store / query client before writing.

Tasks:
1. `commandRanking.ts` + test (red → green).
2. Pointer gate + component test.
3. Wire ranking into `filtered`.
