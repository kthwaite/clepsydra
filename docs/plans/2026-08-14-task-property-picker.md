# Task property picker (due / scheduled / priority in Folio)

Date: 2026-08-14 · Branch: `feature/task-property-picker` (off `develop`)
Follow-up to `docs/plans/2026-08-14-docs-heading-nav.md`, which documented the
gap this closes.

## Scope (interviewed and locked)

1. **Visibility**: task list items (items with a checkbox) render their
   `due`, `scheduled`, and `priority` inline properties as small read-only
   chips at the end of the line. Non-task blocks keep properties invisible.
2. **Entry points** (all three):
   a. clicking a chip — or a hover-revealed control on a task item — opens a
      property popover;
   b. `⌘/Ctrl+Shift+P` (editor scope, label "Task properties") opens the same
      popover for the task item at the caret;
   c. typing `[key:: value]` now works: an inline autoformat rule recognizes
      it on the closing `]` ahead of the link scaffold.
3. **Popover fields**: due + scheduled as native `type="date"` inputs (the
   Bases `DateCell` precedent — no react-aria DatePicker in this repo),
   priority as an A / B / C choice rendered HIGH / MED / LOW (matching
   `TaskList.priorityLabel`), each with a clear affordance.
4. Out of scope: a generic property editor; chips on non-task blocks; chips
   for keys other than the three; overdue highlighting (possible polish
   later); any server change (the save path already round-trips properties).

## Existing mechanics to build on

- Properties live invisibly as `element.properties?: Record<string, string>`
  (`ui/src/editor/schema/types.ts`), parsed on load by the regex at
  `ui/src/editor/convert/mdast-to-slate.ts:693` and re-emitted on save
  (`slate-to-mdast.ts:302-330`). Mutating them via `Transforms.setNodes`
  rides the normal dirty/autosave path.
- The typed form currently breaks because `]` in any non-empty bracket pair
  fires the link scaffold (`inlineTransforms.ts:327-335`); the new property
  rule must be checked before that rule.
- Task items are `list-item` elements with `checked: boolean` (unchecked
  tasks included; `checked` absent means plain bullet); canonical shape
  `list-item > paragraph > text`, rendered in
  `ui/src/editor/schema/elements/list.tsx`.
- Editor-anchored floating UI precedents: the comboboxes and
  `WikilinkInlineEditor` in `ui/src/editor/`; resolve popover anchors lazily
  from the DOM (see memory note on lazy DOM-range resolution), e.g.
  `ReactEditor.toDOMNode` at open time.
- Shortcut registry: `ui/src/lib/shortcuts.ts` + dispatch in
  `SlateEditor.tsx:648-719`. `⌘⇧P` is unclaimed in both scopes. NB the
  matcher treats undeclared `shift` on letter chords as shift-agnostic —
  declare `shift: true`.
- Slate element tests run without `withReact` where possible (memory:
  subagent patterns); jsdom needs the `isContentEditable` shim for
  slate-react tests (already in the repo's test setup).

## Design decisions

- **Shared syntax module**: extract the `[key:: value]` regex plus a
  `TASK_PROPERTY_KEYS = ["due", "scheduled", "priority"] as const` constant
  into a new `ui/src/editor/properties.ts`, imported by `mdast-to-slate.ts`
  (replacing its inline regex) and by the new autoformat rule — one source of
  truth, no drift.
- **Typed rule semantics**: on `]`, if the text before the caret ends with a
  string matching the shared regex, delete the matched text and merge the
  key/value into the nearest ancestor block's `properties`. Any key, any
  property-bearing block (format-faithful, same as loading the file); but
  only task-item chips make the result visible — the docs task states this
  plainly. No trigger inside code blocks or when the `code` mark is active
  (same guards as other inline rules). Same-key typing overwrites.
- **Chips**: in `list.tsx`, render the task row as a flex row
  `[checkbox, content(children), chips]` so chips top-align with the first
  line even when the item has a nested sub-list. Chips are
  `contentEditable={false}`, mono, uppercase, `text-[10px]`/`text-[11px]`,
  bordered, zero radius: `DUE 2026-08-20`, `SCHED 2026-08-15`, and
  `HIGH`/`MED`/`LOW` for priority `A`/`B`/`C` (unknown priority values render
  verbatim). Chips render only when `checked` is boolean AND the key has a
  value. Clicking a chip opens the popover without moving the selection into
  the item. A hover/focus-revealed `+`-style control (opacity-0,
  group-hover/focus-within) appears on task items with none of the three
  keys set.
- **Popover**: one editor-level controller in `SlateEditor` (state: the
  task item's path, plus the anchor DOM node resolved at open), rendered via
  react-aria `Popover`/`Dialog`. Chip clicks and the hover control request
  it through editor context; the `⌘⇧P` handler opens it for the caret's
  enclosing task item (no-op with a message-free pass-through when the caret
  is not in a task item). Fields per scope §3; each commit calls
  `Transforms.setNodes` at the stored path with an updated `properties`
  record (deleting cleared keys; an emptied record becomes `undefined`).
  `Escape` and outside-click close. Date inputs enforce `YYYY-MM-DD` by
  construction (`type="date"`).
- **Vim**: the popover lives outside the editable; opening from normal mode
  is allowed and keys inside the popover must not reach the vim handler.

## Tasks (TDD; subagent per task)

**T1 — shared syntax + typed autoformat rule.** Extract
`ui/src/editor/properties.ts`; rewire `mdast-to-slate.ts`; add the inline
rule ahead of the link scaffold. Tests first: typed `[due:: 2026-08-14]` on a
task item sets `properties.due` and removes the text; precedence over the
link scaffold (the exact case that used to produce `[due:: …]()`); non-task
paragraph also converts; no-op in code blocks/code mark; loader behavior
unchanged (existing convert tests stay green); round-trip: typed property
appears as `[due:: …]` in serialized markdown.

**T2 — chips on task items.** Tests first against the `list.tsx` descriptor
render: chips for each set key with the right labels and A/B/C mapping; no
chips on plain bullets or propertyless tasks; nested-sublist layout keeps
chips on the first line (structural assertion, not pixel); chip carries an
accessible name (e.g. `aria-label="Due 2026-08-20"`). Runs parallel with T1
(different files).

**T3 — popover + entry points** (after T1+T2). Tests: chip click opens with
current values prefilled; hover control opens empty; `⌘⇧P` opens for the
caret task item and does nothing elsewhere; setting/clearing each field
updates the element and closes cleanly; Escape closes without writing;
registry gains `editor.taskProperties` (`{ key: "p", mod: true, shift:
true }`, scope editor) and the shortcut-conflict tests stay green.

**T4 — docs** (after T3). `editor-workflows.mdx`: rewrite "Edit tasks and
their properties" (the gap paragraph becomes the affordance description:
chips, popover, `⌘⇧P`, typed syntax now working), update the shortcut
table and the "Failures and conflicts" bullet (block IDs stay invisible;
properties on task items no longer are), keep the bare-URL caveat.
`tasks-agenda-journals-and-board.mdx`: mention the editor affordance in
Prerequisites and change the `[priority:: P1]` example to the `A`/`B`/`C`
values the agenda UI renders. Verify with mdx-smoke + docs tests.

**T5 — gates + merge.** Full `cd ui && bun run test`, `bun run typecheck`,
`bunx biome check` scoped to changed files (develop is not repo-wide clean).
Rust untouched. Review diffs, commit per logical unit, merge
`feature/task-property-picker` → `develop`, delete branch.
