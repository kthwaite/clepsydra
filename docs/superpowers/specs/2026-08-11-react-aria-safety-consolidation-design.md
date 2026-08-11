# React Aria Safety and Consolidation Design

Date: 2026-08-11

## Goal

Complete the first low-risk tranche of the React Aria audit:

1. make icon-only Bases controls reliably accessible,
2. remove the duplicate Codex tag editor, and
3. give tasking and Settings choice controls correct radio-group semantics.

The tranche must preserve current visuals and domain behavior. Broader command-palette, menu, modal, field, table, Switch, and Tabs migrations remain outside this change.

## Worktree and source state

Implementation will run on a feature branch in an isolated worktree created from `develop`.

The source working tree currently contains uncommitted icon-control edits in `PropertyDefinitionEditor.tsx` and `ViewDefinitionEditor.tsx`, plus unrelated dependency and documentation changes. The feature worktree will reproduce only the two Bases icon-control changes needed by this tranche. It will not carry `package.json`, `bun.lock`, or unrelated documentation changes.

## Icon-button safety

All icon-only actions in the affected Bases editors will use `IconButton`, not `Button size="icon"`. `IconButton` requires an `aria-label` at the type level.

Labels will retain the existing action-and-subject contracts:

- `Move <property> up`
- `Move <property> down`
- `Rename <property>`
- `Remove <property>`
- `Move <column> up`
- `Move <column> down`
- `Remove <column> column`

The unused `Trash` imports introduced by the source working-copy edits will not be carried into the feature branch.

This tranche does not remove `size="icon"` from the public `Button` API because existing non-affected consumers may rely on it. That API restriction can be assessed separately after all current uses are inventoried.

## TagInput consolidation

`src/components/ui/tag-input.tsx` remains the single owner of tag editing behavior. It will gain narrowly scoped presentation options:

- `variant?: "default" | "codex"`
- `valuePrefix?: string`
- `maxSuggestions?: number`

Defaults preserve existing consumers: default visual treatment, no prefix, and the existing suggestion limit.

The Codex variant changes styling only. `valuePrefix="#"` renders the prefix for selected tags and suggestions without storing it in the value. `maxSuggestions={8}` preserves the current Codex limit.

The shared component continues to own filtering, duplicate exclusion, highlighting, focus return after removal, Enter/Tab/comma commit, empty-input Backspace removal, first-Escape suggestion dismissal, second-Escape bubbling, and blur commit.

`InscribeModal` will migrate to shared `TagInput`. `src/components/codex/TagsInput.tsx` will then be deleted with no compatibility alias.

## Choice-control semantics

### Tasking

`DispositionRow` and `PriorityRow` will compose the existing shared RAC `RadioGroup` and `Radio` primitives. Their public props, test IDs, labels, values, colors, and layout remain stable.

The group will have an accessible label. Selection changes flow through RAC `onChange`; consumers continue receiving the selected string. Arrow-key navigation and checked-state semantics come from RAC rather than independent buttons.

The shared `Radio` primitive may receive a narrow styling extension if required to preserve tasking colors and flex sizing. Domain color maps remain in tasking code rather than moving into the generic UI layer.

### Settings

A shared `SegmentedControl` will be added under `src/components/ui`. It composes `RadioGroup` and `Radio` and accepts:

- an accessible label,
- the selected string value,
- an array of `{ id, label, visual? }` options,
- `onChange`, and
- visual class overrides needed by Settings.

Settings mode, density, and accent selection will use this component. Accent swatches remain presentation supplied by Settings; theme-specific accent knowledge will not enter the shared component.

Diegetic chrome remains a button in this tranche. Its correct target is RAC `Switch`, which belongs to a later migration.

## Error handling and state

These controls are synchronous state adapters and introduce no new persistence or network behavior. Existing stores and mutation paths remain unchanged. Disabled state continues to be passed to RAC primitives through `isDisabled`.

Tag normalization remains unchanged: leading `#` is stripped on commit, blank values are ignored, and duplicates are not added.

## Testing

Implementation follows TDD. Each new observable contract is demonstrated by a failing test before production changes.

Required coverage:

1. Bases icon controls expose the existing accessible names and preserve disabled ordering boundaries.
2. Shared `TagInput` Codex presentation renders `#` without storing it, honors an eight-item limit, and preserves keyboard/blur behavior.
3. `InscribeModal` uses the shared component behavior.
4. Tasking choice rows expose radio/radiogroup semantics, update values, preserve test IDs and styles, and support keyboard movement.
5. Settings mode, density, and accents update through segmented radio controls.

After focused tests pass, smoke-test Settings and tasking in the browser. Final verification runs typecheck, lint, and the full test suite.

## Acceptance criteria

- No unlabeled icon-only controls remain in the two affected Bases editor sections.
- `src/components/codex/TagsInput.tsx` is removed and all callers use shared `TagInput`.
- Tasking disposition/priority and Settings mode/density/accent controls expose correct radio semantics and keyboard behavior.
- Existing labels, option order, colors, spacing, and control dimensions remain unchanged; only the Bases text actions intentionally become the already-present icon treatment.
- No unrelated dirty changes are copied into the worktree or commit.
- Focused tests, browser smoke checks, typecheck, lint, and the full test suite pass before merge to `develop`.
