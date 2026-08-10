# Task 10 report: accessible Base embed inspector

## Status

Complete against base `8e250ea818f15d3824570447c9a105e77d40210e`.

Commits:

- `f1578e6` — `feat(ui): configure Folio Base embeds`
- `850f09d` — `fix(ui): harden Base embed inspector`
- `9497c78` — `fix(ui): close Base inspector validation gaps`
- final ARIA closure commit — removes dangling source-repair diagnostic references

## Implementation

- Extracted the saved-view sort controls into `OrderedSortEditor` without changing the existing scalar-sortable field vocabulary, ordered add/remove/reorder behavior, or ascending/descending controls. `ViewDefinitionEditor` now composes the shared editor.
- Added a labelled React Aria modal inspector with initial focus, described native Base/saved-view selectors, the parameterized existing filter builder, ordered sort controls, a `1..200` numeric limit, and Cancel/Save hierarchy using existing Clepsydra tokens and primitives.
- Kept the configured draft local. Base changes select the registry summary's first view, clear filter and sort, and retain limit. View changes retain filter and limit and reset sort to absent/inherited.
- Save is disabled for codec/domain/reference/declared-field diagnostics and while registry or selected-Base detail is refreshing. A successful Save emits one complete `ConfiguredBaseEmbedElement`; the inspector imports no Slate editor or transforms. Cancel and Escape emit no write and invoke the explicit focus-restoration callback.
- Missing Base and saved-view values remain represented as missing selector options and can be repaired through valid registry choices.
- Added source-repair-only handling for invalid persisted nodes. The textarea receives the TOML body extracted from arbitrary-length backtick/tilde fences, including CRLF and unclosed sources, never the fence delimiters. Valid source replaces the complete invalid node once; invalid source remains local with Save disabled.
- Extracted shared pure shape validation from the Markdown codec and layered canonical representation-size validation on structured drafts/serialization. Persisted parsing retains Task 9 compatibility by applying the authored raw-body bound plus shared shape rules only. Existing persistence error messages remain unchanged while inspector diagnostics gain stable field paths.
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

### Review-fix RED/GREEN

The first focused review found six Important issues. Regressions first failed for explicit empty sort persistence, hidden root/group/sort diagnostics, stale canceled drafts across sessions/node replacement, settled detail errors and delayed stale detail, canonical expansion changing persisted parsing, and the unassociated React Aria dialog description. A second independent rereview caught two remaining gaps: root `$` diagnostics were visible but not included in the dialog's accessible description, and a settled refetch error with matching cached detail still permitted Save. A final closure review found that source-repair `$` diagnostics inherited the structured-only root diagnostic ID; focused RED proved the dangling `aria-describedby` token for both parse and canonical-overflow errors.

After normalizing empty inspector sort to inherited, session-scoped resets, full visible and programmatic diagnostic ownership, error-aware detail readiness gating, split shape/canonical-size validation, and explicit dialog description association:

```text
bun run --cwd ui test src/components/bases/__tests__/MembershipEditor.test.tsx src/components/bases/__tests__/ViewsEditor.test.tsx src/components/bases/__tests__/BaseEmbedInspector.test.tsx src/editor/convert/__tests__/baseEmbedMarkdown.test.ts src/components/ui/__tests__/dialog.test.tsx
5 files passed; 171 tests passed.
```

Coverage includes Base/view reset rules, missing references, a real delayed stale-detail transition, missing detail and cached-detail refetch-error gating, local/no-partial writes, closed-to-open and node-replacement resets, inherited empty sort omission, one-node Save, configured and source-repair Cancel, Escape, focus restoration, initial focus, dialog/control descriptions with every IDREF resolved, refreshing/invalid Save states, every structured diagnostic visibly and programmatically associated with its owner, declared/canonical fields, raw-versus-canonical size compatibility, long CRLF/unclosed source extraction, and every shared bound at $N$ and $N+1$ through the inspector.

Vitest emitted only the existing Vite future-native-loader warnings for `__dirname` and extensionless `./mdx-plugin`.

### Typecheck and scoped lint

```text
bun run --cwd ui typecheck
exit 0; no diagnostics

bunx biome check <5 review-fix source/test files>
Checked 5 files; no fixes required.
```

Per task constraints, no broad UI test suite, build, Slate integration, renderer, insertion command, or live-table work was run or added. The inspector has no production caller until Task 11, so browser integration smoke is intentionally deferred to that integration task.
