# Native checkbox and select inventory

## Scope and method

This inventory covers every source occurrence of a native checkbox or native `select` in the post-migration `ui/src/**/*.tsx` tree on 2026-08-12. The searches were the regex equivalents of the required literal searches: `type\s*=\s*["']checkbox["']` (covering `type="checkbox"` and `type='checkbox'`) and `<select\b`. Production counts exclude test and Storybook paths (`__tests__`, `*.test.tsx`, `*.spec.tsx`, `*.stories.tsx`, and `*.story.tsx`); the one excluded match is recorded separately as an intentional fixture. Counts below are source occurrences, not the number of controls produced by a render loop.

The sections are ordered from straightforward follow-up work through controls that require a new interaction contract. Each production occurrence has exactly one approved disposition.

## Direct future migration

| Path | Control | Disposition | Reason |
|---|---|---|---|
| `ui/src/components/bases/BaseEmbedInspector.tsx:400` | Saved-view select | Direct future migration | Controlled single selection with dynamic options and a disabled state maps directly to the shared Select; unlike the Base selector beside it, this control has no native autofocus or focus-registry contract. |
| `ui/src/components/bases/OrderedSortEditor.tsx:132` | Sort-direction select | Direct future migration | Controlled two-option selection has no DOM ref, autofocus, or multiple-selection dependency. |
| `ui/src/components/bases/PropertiesEditor.tsx:300` | New-property-type select | Direct future migration | Controlled single selection over a fixed property-type list has no native DOM integration. |
| `ui/src/components/bases/PropertyDefinitionEditor.tsx:440` | Existing property-type select | Direct future migration | Controlled single selection maps a fixed type list to a property-definition update without native-only behavior. |
| `ui/src/components/bases/PropertyDefinitionEditor.tsx:465` | Relation-cardinality select | Direct future migration | Controlled two-option selection maps directly to the relation `many` flag and has no DOM ref or autofocus contract. |
| `ui/src/components/bases/ViewDefinitionEditor.tsx:419` | Column-to-add select | Direct future migration | Local controlled single selection gates an adjacent Add action and is not registered for validation focus. |
| `ui/src/components/codex/MobileConstellation.tsx:131` | Anchor-page select | Direct future migration | Controlled single selection with a disabled placeholder and dynamic page options has no native DOM dependency. |
| `ui/src/components/tasking/NewTaskModal.tsx:217` | New-task operation select | Direct future migration | Controlled single selection preserves the empty-string unfiled sentinel; the tasking layout needs later assessment but no native-only behavior is present. |
| `ui/src/components/tasking/NewTaskModal.tsx:232` | New-task cycle select | Direct future migration | Controlled single selection preserves the `BACKLOG` sentinel and dynamic cycle order without relying on a DOM ref. |
| `ui/src/components/tasking/TaskEditPanel.tsx:464` | Task operation select | Direct future migration | Controlled single selection patches the project and preserves empty-string clear semantics; no native DOM integration is present. |
| `ui/src/components/tasking/TaskEditPanel.tsx:482` | Task cycle select | Direct future migration | Controlled single selection translates `BACKLOG` to `null`; the interaction can be retained with a later shared-Select migration. |
| `ui/src/routes/feeds.tsx:314` | Feed filter select | Direct future migration | The shared filter wrapper exposes ordinary controlled string selection; only the feeds toolbar layout needs assessment in the later tranche. |

## Needs Switch primitive

| Path | Control | Disposition | Reason |
|---|---|---|---|
| `ui/src/components/codex/Constellation.tsx:187` | Orphans-visible toggle | Needs Switch primitive | This is an independent persistent visibility setting, not membership in a checkbox group; it should use a Switch rather than the new Checkbox primitive. |
| `ui/src/components/codex/Constellation.tsx:196` | Hide-daily toggle | Needs Switch primitive | This independently toggles graph filtering and has switch semantics rather than multi-choice selection semantics. |
| `ui/src/components/codex/MobileConstellation.tsx:166` | Hide-journals toggle | Needs Switch primitive | The native checkbox already declares `role="switch"`; migration should wait for a shared Switch that preserves that semantic contract. |
| `ui/src/components/codex/MobileConstellation.tsx:175` | Show-orphans toggle | Needs Switch primitive | The native checkbox already declares `role="switch"`; replacing it with Checkbox would regress the intended control role. |

## Needs row-selection design

| Path | Control | Disposition | Reason |
|---|---|---|---|
| `ui/src/components/codex/Gazetteer.tsx:411` | Select-all-visible-rows checkbox | Needs row-selection design | The header control coordinates the visible-page selection set and needs an explicit select-all/none/indeterminate contract before primitive migration. |
| `ui/src/components/codex/Gazetteer.tsx:445` | Per-row selection checkbox | Needs row-selection design | The control is nested in a clickable navigation row and deliberately stops event propagation; a migration must design row activation, bulk selection, and keyboard interaction together. |

## Needs DOM ref/autofocus integration

| Path | Control | Disposition | Reason |
|---|---|---|---|
| `ui/src/components/bases/BaseEmbedInspector.tsx:350` | Base selector | Needs DOM ref/autofocus integration | Opening the guided embed inspector depends on native `autoFocus`; the shared Select needs an equivalent focus-entry contract first. |
| `ui/src/components/bases/FilterComparisonEditor.tsx:216` | Filter field select | Needs DOM ref/autofocus integration | The validation focus registry stores this native element under the condition-field diagnostic path. |
| `ui/src/components/bases/FilterComparisonEditor.tsx:280` | Filter operator select | Needs DOM ref/autofocus integration | The validation focus registry stores this native element under the operator diagnostic path. |
| `ui/src/components/bases/OrderedSortEditor.tsx:91` | Sort-field select | Needs DOM ref/autofocus integration | Validation diagnostics register and later focus the native select element for the indexed sort-field path. |
| `ui/src/components/bases/ViewDefinitionEditor.tsx:251` | View-layout select | Needs DOM ref/autofocus integration | The view validation focus registry stores the native select for the layout diagnostic path. |
| `ui/src/components/bases/ViewDefinitionEditor.tsx:480` | Group-by select | Needs DOM ref/autofocus integration | The view validation focus registry stores the native select for the `group_by` diagnostic path. |
| `ui/src/components/bases/ViewDefinitionEditor.tsx:523` | Aggregate-function select | Needs DOM ref/autofocus integration | One native element is registered under both aggregate-level and function-specific diagnostic paths, which a replacement must preserve. |
| `ui/src/components/bases/ViewDefinitionEditor.tsx:565` | Aggregate-field select | Needs DOM ref/autofocus integration | The validation focus registry stores the native select for the indexed aggregate-field diagnostic path. |
| `ui/src/components/bases/cells/BoolCell.tsx:14` | Inline boolean editor select | Needs DOM ref/autofocus integration | The cell-editing contract depends on native autofocus, blur cancellation, and custom Tab/Escape commit navigation. |
| `ui/src/components/bases/cells/SelectCell.tsx:16` | Inline single-select editor | Needs DOM ref/autofocus integration | The cell-editing contract depends on native autofocus, blur cancellation, custom Tab/Escape handling, and retention of novel open-vocabulary values. |

## Needs native multiple-select replacement

| Path | Control | Disposition | Reason |
|---|---|---|---|
| `ui/src/components/bases/FilterComparisonEditor.tsx:336` | Boolean filter-value select | Needs native multiple-select replacement | The same source control becomes `multiple` for the `in` operator and commits all selected boolean options; a single-select primitive cannot preserve that mode. It also participates in the validation focus registry. |
| `ui/src/components/bases/FilterComparisonEditor.tsx:378` | Declared-option filter-value select | Needs native multiple-select replacement | The control conditionally becomes `multiple` for the `in` operator and commits the complete selected-option array; replacement needs a collection-selection design and must retain focus-registry support. |
| `ui/src/components/bases/cells/MultiSelectCell.tsx:40` | Inline multi-select cell editor | Needs native multiple-select replacement | Native `multiple`, size, full-set commit, autofocus, blur, Enter, Tab, Escape, and novel-value behavior form one editing contract that the shared single Select does not implement. |

## Embedded editor content; retain native

| Path | Control | Disposition | Reason |
|---|---|---|---|
| `ui/src/editor/schema/elements/list.tsx:67` | Slate task-list checkbox | Embedded editor content; retain native | The checkbox is a non-editable inline affordance inside Slate content and updates the task-list node through Slate path lookup, transforms, and history batching; retaining the semantic native input avoids introducing composite-widget behavior into editable content. |
| `ui/src/editor/schema/elements/conversationTurn.tsx:84` | Conversation-turn participant select | Embedded editor content; retain native | The select lives in a `contentEditable={false}` Slate turn affordance and updates the element at its live Slate path; it should remain a simple native control inside editor content. |

## Intentional native fixture (excluded from production totals)

| Path | Control | Disposition | Reason |
|---|---|---|---|
| `ui/src/components/codex/__tests__/FolioAiConversation.test.tsx:181` | Mock conversation participant select | Intentional native fixture | The test-local editor double deliberately renders the participant control needed to exercise conversation-folio behavior; it is not shipped production UI and mirrors the retained native editor-content control. |

## Search reconciliation

### Native checkbox search

Production: **7 occurrences across 4 paths**. Tests/stories: **0 occurrences**.

| Production path | Occurrences |
|---|---:|
| `ui/src/components/codex/Constellation.tsx` | 2 |
| `ui/src/components/codex/Gazetteer.tsx` | 2 |
| `ui/src/components/codex/MobileConstellation.tsx` | 2 |
| `ui/src/editor/schema/elements/list.tsx` | 1 |
| **Total** | **7** |

The double-quoted literal form accounts for all 7 matches; the single-quoted literal form accounts for 0.

### Native select search

Raw search: **27 occurrences across 15 paths**. Excluding the one test fixture above leaves **26 production occurrences across 14 paths**; stories contribute 0.

| Production path | Occurrences |
|---|---:|
| `ui/src/components/bases/BaseEmbedInspector.tsx` | 2 |
| `ui/src/components/bases/FilterComparisonEditor.tsx` | 4 |
| `ui/src/components/bases/OrderedSortEditor.tsx` | 2 |
| `ui/src/components/bases/PropertiesEditor.tsx` | 1 |
| `ui/src/components/bases/PropertyDefinitionEditor.tsx` | 2 |
| `ui/src/components/bases/ViewDefinitionEditor.tsx` | 5 |
| `ui/src/components/bases/cells/BoolCell.tsx` | 1 |
| `ui/src/components/bases/cells/MultiSelectCell.tsx` | 1 |
| `ui/src/components/bases/cells/SelectCell.tsx` | 1 |
| `ui/src/components/codex/MobileConstellation.tsx` | 1 |
| `ui/src/components/tasking/NewTaskModal.tsx` | 2 |
| `ui/src/components/tasking/TaskEditPanel.tsx` | 2 |
| `ui/src/editor/schema/elements/conversationTurn.tsx` | 1 |
| `ui/src/routes/feeds.tsx` | 1 |
| **Production total** | **26** |
| Excluded: `ui/src/components/codex/__tests__/FolioAiConversation.test.tsx` | 1 |
| **Raw total** | **27** |

### Overall production total by disposition

| Disposition | Checkbox occurrences | Select occurrences | Total |
|---|---:|---:|---:|
| Direct future migration | 0 | 12 | 12 |
| Needs Switch primitive | 4 | 0 | 4 |
| Needs row-selection design | 2 | 0 | 2 |
| Needs DOM ref/autofocus integration | 0 | 10 | 10 |
| Needs native multiple-select replacement | 0 | 3 | 3 |
| Embedded editor content; retain native | 1 | 1 | 2 |
| **Production total** | **7** | **26** | **33** |

The production tables therefore contain **33 rows across 17 unique production paths**, exactly matching the 7 checkbox and 26 select search occurrences. The separate fixture table contains the sole excluded match and is not included in that production total.
