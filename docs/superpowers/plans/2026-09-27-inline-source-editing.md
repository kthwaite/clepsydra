# Inline source editing — plan (2026-09-27)

Branch `feature/link-polish`, worktree `.worktrees/link-polish`. Paths below are relative to `ui/src/editor/`.

## Goal

Moving the caret into an inline reference with ←/→ shows its raw Markdown
source for editing, the way wikilinks already do. This covers Markdown links,
block refs, footnote refs and inline math.

## Rulings (user, 2026-09-27)

- **Markdown links: hybrid.** `link` stays a non-void inline, and a plain click still puts the caret in the label. Moving in with ←/→ from outside, at a text boundary next to the link, opens an inline source editor holding the full `[label](url)`. The label is Markdown, so marks survive. On commit the draft is re-parsed as inline Markdown and replaces the link node. If the draft no longer parses as a link, the parsed inline content replaces it (so deleting the brackets unlinks). An empty draft cancels.
- **Block refs:** the source editor shows `((`/`))` as chrome around an id input. Commit only accepts an id matching the existing block-id grammar `[A-Za-z0-9]{10,12}`. Otherwise the input is marked `aria-invalid` and Enter does nothing. Esc cancels.
- **Footnote refs:** the source editor shows `[^`/`]` as chrome around the identifier. A commit that changes the identifier only repoints the ref. If no `footnote-def` with the new identifier exists, append an empty one at the end of the document, as the `[^id]` autoformat does (`plugins/autoformat/inlineTransforms.ts:390-425`). The old def is left alone.
- **Inline math:** ←/→ next to an `inline-math` void calls `mathEditing.begin` (existing MathElement source editor and its edge exits). Enter still works as today.
- Wikilink behaviour must not change.

## Current machinery (from exploration)

- `wikilinkEditing.tsx` holds the session `{path, initialCaret, returnSide}` as a raw Path. It has `begin`, `commit(parsed, exit)`, `cancel(exit)`, `selectExit` and `findAdjacentWikilink`. The adjacency check (sibling ±1, caret at offset 0 or at the text end) is generic, but `:81` hardcodes `type === "wikilink"`. `commit` hardcodes the `target`/`alias` setNodes.
- `WikilinkInlineEditor.tsx` is an `<input>` with caret placement, the finish guard and the key handling (Enter, Esc, edge arrows, blur=preserve, Cmd-Enter=open). The parse is `parseWikilinkDraft`.
- `SlateEditor.tsx:725-735` routes ←/→ to `findAdjacentWikilink`, then to `wikilinkEditing.begin`.
- `mathEditing.tsx` uses a PathRef, and `MathElement.tsx:84-94` has edge exits.
- The inline converters are `convert/index.ts` (`markdownToSlate`, `slateToMarkdown`).

## Tasks (TDD; each ends green on `bun run test <touched files>` + typecheck)

### T1 — Generalise the controller (refactor, no behaviour change)
- Rename or extend `wikilinkEditing` into an inline-source-editing controller keyed by element type. It needs a per-type adapter `{ type, toDraft(node), parse(draft) → {kind:"commit", apply(editor, path)} | {kind:"cancel"} | {kind:"invalid"} }`.
- The session stores a **PathRef**, not a raw Path.
- Generalise `findAdjacentWikilink` → `findAdjacentSourceInline(editor, key, types)`.
- Generalise `WikilinkInlineEditor` → a source input that takes `parse` and supports the `invalid` state (`aria-invalid`, Enter ignored).
- Wikilink is the first adapter. The existing wikilink tests (`__tests__/wikilinkEditing.test.tsx`, `WikilinkElement.test.tsx`, the inline-editor tests) must pass with only mechanical import or name updates.
- Add tests: PathRef survives an insertion before the element mid-session; the adapter's `invalid` result keeps the session open.

### T2 — Inline math on ←/→
- Test first: a caret at offset 0 after `inline-math` + ← begins a math session (and → at end before it likewise). In the SlateEditor keydown path, route `inline-math` adjacency to `mathEditing.begin`. The existing math tests stay green.

### T3 — Block ref adapter
- Tests first: ← adjacency begins a session. The draft is the id. Chrome `((`/`))` renders. A valid new id commits `setNodes {blockId}`. An invalid id → `aria-invalid`, no commit. Esc restores the node unchanged. Wire the source input into `BlockRefElement.tsx` like `WikilinkElement.tsx:75-107`.

### T4 — Footnote ref adapter
- Tests first: the draft is the identifier with chrome `[^`/`]`. A commit to an existing def's id repoints only. A commit to a new id repoints and appends an empty def. The old def stays. An empty draft cancels. Extract the "ensure footnote def" step from `inlineTransforms.ts` into a shared helper, not a copy.

### T5 — Markdown link adapter (hybrid)
- Tests first: → at the end of the text before a link begins a session (← at the start of the text after one likewise). The draft equals the `slateToMarkdown` inline form (`[**b** x](https://e.com)`). Committing an edited url or label replaces the node, and marks are preserved. Committing text without link syntax replaces it with plain inline content. An empty draft cancels. A plain click inside the label still places the caret (no session). Punctuation-boundary and autoformat tests stay green.
- `LinkElement.tsx` renders the source input while a session is active. Keep the Slate children mounted but hidden, so the DOM mapping holds, and move the selection outside the link before `begin`.
- Update `__tests__/wikilinkEditing.test.tsx:132-150`, which asserts that links are not adjacent-editable.

### T6 — Docs, smoke, gates
- Update `docs/content/editor-workflows.mdx` and `getting-started.mdx`: arrow into links, block refs, footnote refs and math to edit their source.
- Browser smoke on the dev server: each of the four types, entry from both sides, commit, cancel, exit arrows.
- Gates: `bun run typecheck`, `bun run lint`, `bun run test` (full), `bun run knip`. Then review, then merge to `develop`.
