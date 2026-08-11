# Task 5 report

## Status

Complete. Parseable Recipe Folios now open in a dedicated semantic Read view and a structured Edit view. Malformed recipes remain in the generic Slate editor with an explicit preservation notice.

## Files

- Created `ui/src/components/codex/recipe/RecipeFolioBody.tsx`
- Created `ui/src/components/codex/recipe/RecipeFolioBody.test.tsx`
- Modified `ui/src/components/codex/Folio.tsx`
- Created `ui/src/components/codex/__tests__/FolioRecipe.test.tsx`

No backend, codec, raw-body hook, AI conversation component, or other implementation file changed.

## Commit

- `d936dcc` — `feat(ui): add structured recipe folio`

## Red / green evidence

### Red: missing Recipe body component

Command:

```text
bun run --cwd ui test src/components/codex/recipe/RecipeFolioBody.test.tsx
```

Observed before implementation: the suite failed to resolve `./RecipeFolioBody`, with 1 failed test file and 0 collected tests. This was the expected missing-component failure.

### Red: missing Folio integration

Command:

```text
bun run --cwd ui test src/components/codex/__tests__/FolioRecipe.test.tsx
```

Observed before Folio integration: 6 of 7 tests failed because Recipe Folios still exposed the generic editable header/Slate surface and had no Recipe mode controls or preservation alert. The locked-Folio precedence test already passed.

### Red: empty structured-row lifecycle

Command:

```text
bun run --cwd ui test src/components/codex/__tests__/FolioRecipe.test.tsx -t "keeps a new empty row"
```

Observed against the first integration pass: the test failed because `Ingredient 3` disappeared after canonical serialization omitted the empty value. Folio now keeps an in-memory structured draft keyed by path and editor revision while still persisting only canonical Markdown.

### Green: focused Recipe and AI regressions

Command:

```text
bun run --cwd ui test src/components/codex/recipe/RecipeFolioBody.test.tsx src/components/codex/__tests__/FolioRecipe.test.tsx src/components/codex/__tests__/FolioAiConversation.test.tsx
```

Observed: 3 files passed, 26 tests passed, 0 failed.

Coverage includes semantic read output, safe bold/wikilink notes, absence of ingredient checkboxes, labelled segmented Read/Edit selection, controlled text edits, keyboard add/remove/reorder behavior, new-row focus, exact Unicode-bullet serialization, keyboard save, malformed-body preservation, revision conflicts, path reset/reparse, encryption precedence, and unchanged AI conversation behavior.

### Green: typecheck

Command:

```text
bun run --cwd ui typecheck
```

Observed: `tsc --noEmit --project tsconfig.app.json` exited successfully with no diagnostics.

### Browser smoke evidence

The component was rendered through the running Vite application in Chromium at desktop (`1440 × 1000`) and mobile (`390 × 844`) viewports. The desktop editor retained the Vessel rail-and-rule visual language; the mobile layout stacked fields and moved row actions below each input without horizontal overflow. Keyboard activation of `Add ingredient` created `Ingredient 4` and moved focus into its input.

The brief's literal `bun --cwd ui run test ...` ordering printed Bun usage with the installed Bun version. All substantive runs used the equivalent accepted ordering `bun run --cwd ui test ...`.

Per the assignment, formatting, lint, build, and project-wide tests were not run.

## Accessibility and design choices

- Reused the shared `SegmentedControl`, which exposes Recipe mode as a named React Aria radio group with native arrow-key selection.
- Reused shared React Aria `Button` and `TextField` controls. Row actions have stable names such as `Move ingredient 2 up`; impossible moves are disabled.
- New ingredient and step rows receive focus after insertion. Add, remove, move-up, and move-down actions use React Aria press behavior for pointer and keyboard parity.
- Read mode uses named `section` landmarks plus semantic unordered Ingredients and ordered Steps lists. Ingredients deliberately have no checkbox or completion state.
- Notes and description use the existing safe `MarkdownRenderer`; no raw-HTML plugin or alternate Markdown path was introduced.
- Styling stays within existing Vessel tokens (`paper`, `ink`, `rule`, `accent`) and typography. Section rules encode recipe structure; ordered-step markers carry the sole visual emphasis.
- The read layout uses a responsive ingredients/steps split that collapses to one column. Edit rows stack actions beneath inputs at narrow widths.
- No persisted completion affordance, drag-and-drop, animation, new palette, or unrelated decoration was added.

## Self-review

- Folio performs Recipe parsing in one `useMemo`; neither `RecipeFolioBody` nor fallback rendering parses or serializes source Markdown.
- Successful Recipe changes flow only through `serializeRecipeMarkdown(nextDocument)` and `editor.setBodyMarkdown(...)`.
- The local structured draft preserves newly added empty rows for typing while serialization omits them. It is keyed by path and editor revision and is cleared on path changes, so navigation reparses source rather than leaking prior state.
- Parse failure does not call `setBodyMarkdown` during mount, assignment, or fallback editing; the existing Slate callbacks remain authoritative for malformed source.
- Recipe Read mode generalizes Folio mutation guards for the header, kind/project/protection surfaces, attachments, organization, save shortcut, and conflict status. Conversation-specific provider context, editor ref, diagnostics, CSS mode, and Slate read-only behavior remain conversation-only.
- Locked encrypted Folios return before Recipe controls render.
- Revision-conflict rerenders do not reset Recipe mode or the structured draft.
- All collection updates copy only the changed array/document; there is no drag state, checkbox state, or avoidable Markdown round-trip inside the body component.

## Concerns

- Vitest emitted the existing Vite native-config warning about `__dirname` and the extensionless `./mdx-plugin` import; it did not affect the focused results.
- No other concerns observed in the assigned scope.
