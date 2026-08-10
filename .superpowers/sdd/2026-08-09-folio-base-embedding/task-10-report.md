# Task 10 report: accessible Base embed inspector

## Status

Complete against base `8e250ea818f15d3824570447c9a105e77d40210e`.

Commit: this scoped Task 10 commit (`feat(ui): configure Folio Base embeds`).

## Implementation

- Extracted the saved-view sort controls into `OrderedSortEditor` without changing the existing scalar-sortable field vocabulary, ordered add/remove/reorder behavior, or ascending/descending controls. `ViewDefinitionEditor` now composes the shared editor.
- Added a labelled React Aria modal inspector with initial focus, described native Base/saved-view selectors, the parameterized existing filter builder, ordered sort controls, a `1..200` numeric limit, and Cancel/Save hierarchy using existing Clepsydra tokens and primitives.
- Kept the configured draft local. Base changes select the registry summary's first view, clear filter and sort, and retain limit. View changes retain filter and limit and reset sort to absent/inherited.
- Save is disabled for codec/domain/reference/declared-field diagnostics and while registry or selected-Base detail is refreshing. A successful Save emits one complete `ConfiguredBaseEmbedElement`; the inspector imports no Slate editor or transforms. Cancel and Escape emit no write and invoke the explicit focus-restoration callback.
- Missing Base and saved-view values remain represented as missing selector options and can be repaired through valid registry choices.
- Added source-repair-only handling for invalid persisted nodes. The textarea receives the TOML body extracted from arbitrary-length backtick/tilde fences, including CRLF and unclosed sources, never the fence delimiters. Valid source replaces the complete invalid node once; invalid source remains local with Save disabled.
- Extracted a shared pure structured validator from the Markdown codec. Persisted parsing and inspector drafts now use the same closed-shape, limit, filter-depth/node/group/`in`, sort-count, body-size, field-byte, scalar-string-byte, operator, direction, and TOML-data rules. Existing persistence error messages remain unchanged while inspector diagnostics gain stable field paths.
- Parameterized membership/filter diagnostics so selected-Base declared-field errors attach through `aria-invalid`/`aria-describedby` to filter and sort controls.

## TDD evidence

### RED

```text
bun run --cwd ui test src/components/bases/__tests__/BaseEmbedInspector.test.tsx
1 file failed; 32/32 tests failed for the absent inspector shell, shared validator export, controls, transitions, source repair, and callbacks.
```

The pre-extraction baseline was green before refactoring:

```text
bun run --cwd ui test src/components/bases/__tests__/ViewsEditor.test.tsx
1 file passed; 20 tests passed.
```

### GREEN

```text
bun run --cwd ui test src/components/bases/__tests__/MembershipEditor.test.tsx src/components/bases/__tests__/ViewsEditor.test.tsx src/components/bases/__tests__/BaseEmbedInspector.test.tsx src/editor/convert/__tests__/baseEmbedMarkdown.test.ts
4 files passed; 141 tests passed.
```

Coverage includes Base/view reset rules, missing references, rapid Base changes, local/no-partial writes, one-node Save, configured and source-repair Cancel, Escape, focus restoration, initial focus, accessible labels/descriptions, refreshing/invalid Save states, declared and canonical fields, source body extraction for long CRLF and unclosed fences, and every shared bound at $N$ and $N+1$.

Vitest emitted only the existing Vite future-native-loader warnings for `__dirname` and extensionless `./mdx-plugin`.

### Typecheck and scoped lint

```text
bun run --cwd ui typecheck
exit 0; no diagnostics

bunx biome check <8 scoped Task 10 source/test files>
Checked 8 files; no fixes required.
```

Per task constraints, no broad UI test suite, build, Slate integration, renderer, insertion command, or live-table work was run or added. The inspector has no production caller until Task 11, so browser integration smoke is intentionally deferred to that integration task.
