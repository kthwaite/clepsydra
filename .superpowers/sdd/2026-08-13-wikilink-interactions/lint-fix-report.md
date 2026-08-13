# Wikilink Lint Fix Report

## Scope

Replaced the three feature-owned `span role="link"` implementations with semantic anchors:

- the missing-target trigger in `WikilinkElement`;
- both trigger fixtures in `MissingWikilinkPopover.test.tsx`;
- the `CLink` mock in `WikilinkElement.test.tsx`.

The production trigger renders without an `href`, so click, Enter, middle-click, auxiliary activation, and the browser context menu have no native navigation target. Its explicit link role and existing click/Enter handlers preserve accessibility queries and the established modifier/editing policy; those handlers still call `preventDefault()` and `stopPropagation()`. Explicit tab focus, classes, the `contentEditable={false}` boundary, Floating UI child composition, and role-based test selectors remain intact.

## Verification

Run from `ui/`:

```text
./node_modules/.bin/biome lint src/editor/elements/WikilinkElement.tsx src/editor/__tests__/MissingWikilinkPopover.test.tsx src/editor/__tests__/WikilinkElement.test.tsx
```

Result: exit 0; 3 files checked with no diagnostics.

```text
./node_modules/.bin/vitest run src/editor/__tests__/MissingWikilinkPopover.test.tsx src/editor/__tests__/WikilinkElement.test.tsx src/editor/__tests__/SlateEditor.wikilink-editing.test.tsx src/editor/__tests__/SlateEditor.wikilink-create.test.tsx
```

Result: exit 0; 4 files passed, 47 tests passed. Vitest emitted the existing Vite native-config and jsdom `scrollTo` warnings only.

```text
bun run typecheck
```

Result: exit 0 (`tsc --noEmit --project tsconfig.app.json`).

## Self-review

No navigation, click/Enter modifier policy, styling, editor boundary, Floating UI composition, selector, API, or documentation behavior changed. No fix-owned concerns remain.

## Review correction

Removed the live `href="/"` fallback from the production trigger and all semantic test anchors. Because an href-free anchor has no implicit ARIA role, the explicit `link` role and custom activation props are composed together; the rendered element remains an href-free `<a>` and changed-file Biome lint passes without a suppression. The production regression assertion now verifies that the unresolved trigger has no `href`.

The `CLink` test mock now mirrors production keyboard activation by forwarding Enter to its supplied click handler instead of discarding the key event. Existing plain/modifier click and Enter policy tests continue to exercise the same activation callback.

Post-review verification from `ui/`:

```text
./node_modules/.bin/biome lint src/editor/elements/WikilinkElement.tsx src/editor/__tests__/MissingWikilinkPopover.test.tsx src/editor/__tests__/WikilinkElement.test.tsx
```

Result: exit 0; 3 files checked with no diagnostics.

```text
./node_modules/.bin/vitest run src/editor/__tests__/MissingWikilinkPopover.test.tsx src/editor/__tests__/WikilinkElement.test.tsx src/editor/__tests__/SlateEditor.wikilink-editing.test.tsx src/editor/__tests__/SlateEditor.wikilink-create.test.tsx
```

Result: exit 0; 4 files passed, 47 tests passed.

```text
bun run typecheck
```

Result: exit 0 (`tsc --noEmit --project tsconfig.app.json`).
