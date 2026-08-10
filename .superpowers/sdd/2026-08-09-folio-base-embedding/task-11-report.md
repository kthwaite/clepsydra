# Task 11 report: Slate Base insertion, focus, and live table integration

## Status

Complete. Task 11 production is implemented in `c3d5bb4` (`feat(editor): operate Base views inside Folios`), and review commit `5c0587117d2d60a5980230d0060405594fd07ab5` (`test(editor): close Base embed ownership gaps`) closes the three Important test-quality findings. The commits contain only Task 11 source, tests, story work, and the narrowly grounded stale diagnostic-ID assertion described below.

## RED evidence

Required command:

```text
bun run --cwd ui test src/editor/__tests__/slashCommandToConversion.test.ts src/editor/__tests__/SlateEditor.base-embed.test.tsx src/editor/elements/BaseEmbedElement.test.tsx
```

Initial result: 3 test files failed as expected.

- `slashCommandToConversion.test.ts`: `SC-07` failed because the Base command was absent.
- `BaseEmbedElement.test.tsx`: suite failed to resolve the intentionally absent `#/editor/baseEmbedEditing` module.
- `SlateEditor.base-embed.test.tsx`: all 16 characterization tests failed because slash discovery returned “No commands found” and the Base renderer/session/focus behavior did not exist.
- jsdom also reported missing `Range.getBoundingClientRect`; the harness received the same DOM Range polyfill used by the existing Slate tests before GREEN.

### Review-closure mutation RED

The review identified three assertions that were weaker than their labels. Each replacement was mutation-checked before GREEN:

- Removing the production `ReactEditor.isFocused(editor)` branch made the false-focus test fail because the spy was not consumed; the replacement dispatches Delete at the real `Editable`, proves the spy was called with the mounted editor, and preserves the exact selected node identity.
- Recreating the editor when the parent’s persisted `initialValue` changes made the async persistence test lose the table focus. The replacement drives the platform-correct real save chord, waits on an asynchronous gate, serializes to Markdown, reloads Markdown into parent persistence state, and only then checks descendant focus and the original Slate selection.
- Removing both unmount obsoletion defenses from the queued undefined-sort path made the dedicated test observe a `set_node` through its `editor.apply` spy:

```text
bun run --cwd ui test src/editor/elements/BaseEmbedElement.test.tsx -t "obsoletes queued and later controller work when unmounted"
# RED: 1 failed; queued undefined sort emitted set_node after unmount
```

All deliberate production mutations were then restored before the focused GREEN run.

## Implementation

- Added a dedicated Base editing provider/controller with a `PathRef`, original-node identity, insertion `RangeRef`, registered entry-focus handle, exact replacement/removal, bookmark restoration, deterministic following/preceding fallback, and lifecycle cleanup.
- Added special `executeSlashCommand` handling for **Base embed**. It deletes the slash query, inserts exactly one selected unconfigured void, preserves the empty paragraph bookmark, and opens that exact identity in the inspector. `slashCommandToConversion("base")` remains `null`.
- Added `BaseEmbedElement` as the descriptor renderer. Slate attributes remain on the top-level element, Slate children are retained, and all renderer controls live below `contentEditable={false}`. It owns selection chrome, guards, Edit/Remove, inspector restoration, Escape ownership, and removal fallback without adding an application role or labelled table region.
- Added `EmbeddedBaseTable` as the sole Slate/live-controller adapter. It passes the node’s exact filter/limit/sort configuration to the shared embedded controller, coalesces the controller’s view-reset callback pair into one exact-node transform, replaces header sort arrays, prevents stale callbacks after unmount, preserves member-property mutations outside Slate, and supplies Base configuration navigation.
- Registered the Base editing provider in the real `SlateEditor`; Enter/F2 entry and focused-only Backspace/Delete are handled before existing math/editor commands.
- Added a recoverable mocked-reference Base embed story through the production schema renderer.

## Characterization coverage

### Command/session

- slash discovery and special-command exclusion from generic block conversion;
- exactly one selected unconfigured void and inspector opening;
- Save replaces only the tracked identity after path shifts;
- Cancel removes only that identity and restores the insertion bookmark;
- emergency empty-fence save/reload becomes invalid source-repair state;
- configured and invalid Cancel preserve the complete original node and restore **Edit embed**;
- external removal while the inspector is open cleans up the session.

### Keyboard/focus ownership

- selected-void Enter and F2 use table/view, Edit, Remove priority;
- before Shift+Tab, including first-block after-point fallback;
- after Tab;
- unhandled versus descendant-prevented Escape;
- false-focus Delete dispatches through the real `Editable`, consumes `ReactEditor.isFocused(editor)`, preserves the exact selected node, and retains the focused positive deletion branch;
- following then preceding removal fallback;
- inspector restoration;
- a platform-correct save chord, asynchronous Markdown persistence round trip, parent state update, and post-update descendant focus/Slate selection stability.

### Live adapter

- exact embed filter/limit/sort input;
- view changes preserve filter/limit and remove sort with one node transform;
- header sort replaces every prior key;
- property commits never issue a Slate node transform;
- title and configure navigation;
- loading, missing Base/view, uncached error, cached error, and cached/loading recovery;
- undefined sort work is queued while mounted, unmounted before microtask flush, and proven not to emit `set_node`; later stale callbacks are also inert;
- renderer attributes/children/content-editable boundaries and single-region ownership.

## Branch regression closed

The required combined suite exposed a stale assertion in `BaseDefinitionWorkspace.test.tsx`. Commit `f1578e6` intentionally extracted `OrderedSortEditor` and established `${idPrefix}-sort-field-error-${index}`; `ViewDefinitionEditor` supplies `view-${viewIndex}`, so the rendered contract is `view-0-sort-field-error-0`. The old assertion still expected the pre-extraction `view-sort-field-error-0-0`. Only those two stale expected IDs were corrected; the isolated regression and complete editor/Base suite now pass.

## Verification

```text
bun run --cwd ui test src/editor/__tests__/slashCommandToConversion.test.ts src/editor/__tests__/SlateEditor.base-embed.test.tsx src/editor/elements/BaseEmbedElement.test.tsx
# 3 files passed; 36 tests passed

bun run --cwd ui test src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx -t "blocks a stale sort after a scalar property becomes a relation and focuses its field"
# 1 file passed; 1 passed, 24 skipped

bun run --cwd ui test src/editor
# 63 files passed; 1046 tests passed

bun run --cwd ui test src/editor src/components/bases
# 79 files passed; 1352 tests passed

bun run --cwd ui typecheck
# tsc --noEmit --project tsconfig.app.json; passed

bunx biome check --write src/editor/baseEmbedEditing.tsx src/editor/elements/BaseEmbedElement.tsx src/editor/elements/EmbeddedBaseTable.tsx src/editor/schema/elements/baseEmbed.tsx src/editor/SlateEditor.tsx src/editor/__tests__/slashCommandToConversion.test.ts src/editor/__tests__/SlateEditor.base-embed.test.tsx src/editor/elements/BaseEmbedElement.test.tsx src/editor/schema/elements.stories.tsx src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx
# 10 files checked; no fixes required on the final run

bunx biome lint src/editor/baseEmbedEditing.tsx src/editor/elements/BaseEmbedElement.tsx src/editor/elements/EmbeddedBaseTable.tsx src/editor/schema/elements/baseEmbed.tsx src/editor/SlateEditor.tsx src/editor/__tests__/slashCommandToConversion.test.ts src/editor/__tests__/SlateEditor.base-embed.test.tsx src/editor/elements/BaseEmbedElement.test.tsx src/editor/schema/elements.stories.tsx src/components/bases/__tests__/BaseDefinitionWorkspace.test.tsx
# 10 files checked; no fixes applied
```

Vitest emitted the repository’s existing Vite native-config warning and jsdom `Window.scrollTo()` notices; neither produced a test failure. The worktree was clean immediately after `5c0587117d2d60a5980230d0060405594fd07ab5` and before correcting this report.

## Self-review

Every Task 11 brief bullet maps to a rendered behavioral assertion. The implementation has no global renderer switch, second `role="application"`, Folio-specific persistence path, duplicate labelled table region, BaseTableView semantic change, partial view transform, or source-text-only assertion. Every outer Base Escape handler checks `defaultPrevented` before acting. All task source, tests, story, and the grounded branch-regression correction are committed; no implementation concern remains.
