# Checkbox, CheckboxGroup, and Select Design

Date: 2026-08-12

## Goal

Provide styled React Aria Components primitives for Checkbox, CheckboxGroup, and Select, expand their Storybook coverage, and migrate the first low-risk native checkbox/select call sites.

The controls must use Clepsydra's Vessel tokens, preserve React Aria semantics and state APIs, and match the established shared-field conventions in `ui/src/components/ui`. The change will also produce a complete, ranked inventory of remaining native checkbox and select elements.

## Existing state

`ui/src/components/ui/select.tsx` is a partial adaptation of the React Aria Select starter. It already exports generic `Select`, `SelectListBox`, and `SelectItem` components and reuses the shared Button, Popover, and ListBox primitives. Its field, trigger, value, popover, item, disabled, invalid, and focus styling are incomplete. Its stories cover only default and default-selected cases.

No shared Checkbox or CheckboxGroup primitive exists. Product code contains native checkbox and select elements with duplicated labels, state adaptation, disabled handling, focus styling, and layout.

Implementation will run on a feature branch in an isolated worktree created from `develop`. The current source tree contains the unrelated untracked file `docs/design-notes/2026-08-11-pkm-feature-comparison.md`; it must not enter this feature's commits.

## Chosen approach

Adapt the official React Aria starter composition to Clepsydra's existing component and token system.

This approach preserves the RAC collection and form APIs, reuses existing shared primitives, and avoids introducing either unstyled re-exports or a competing options-array abstraction. The existing compositional Select API remains the only shared Select API.

## Shared field presentation

CheckboxGroup and Select use the same field structure as TextField:

- labels use the existing uppercase, tracked, muted field-label treatment,
- descriptions use small muted text,
- validation errors use small destructive text,
- disabled controls use reduced opacity and a not-allowed cursor,
- focus-visible state uses the semantic ring token,
- invalid state uses the destructive token,
- all geometry remains zero-radius.

No new global design tokens or global component CSS are required. Styling remains colocated as Tailwind classes in the primitives.

## Checkbox

Add `ui/src/components/ui/checkbox.tsx`.

`Checkbox` composes RAC `CheckboxField` and `CheckboxButton`. Its props extend `CheckboxFieldProps` and add:

- `children?: ReactNode`,
- `description?: string`, and
- `errorMessage?: string | ((validation: ValidationResult) => string)`.

RAC remains responsible for controlled and uncontrolled state, form submission, required validation, read-only behavior, disabled behavior, and accessible relationships.

The visible control is a square, zero-radius indicator. It renders a Lucide `Check` when selected and `Minus` when indeterminate. The indicator uses Vessel background, border, foreground, accent, and destructive tokens. The checkbox button handles hovered, pressed, focus-visible, selected, indeterminate, invalid, and disabled states through RAC data attributes.

The label is supplied through `children`. Description and error content are aligned with the label text rather than the indicator.

## CheckboxGroup

Add `ui/src/components/ui/checkbox-group.tsx`.

`CheckboxGroup` wraps RAC `CheckboxGroup` and accepts:

- optional `label`,
- optional `description`,
- optional `errorMessage`,
- optional `children`, and
- `orientation?: "vertical" | "horizontal"`, defaulting to `"vertical"`.

The group renders an RAC Label, a dedicated items container, Description, and FieldError. The items container changes flex direction from the orientation prop. Child checkboxes remain normal composable `Checkbox` elements; the group does not introduce an options-array API.

RAC remains responsible for controlled/uncontrolled string-array values, required-group validation, disabled/read-only propagation, form naming, and accessible group semantics.

## Select

Upgrade `ui/src/components/ui/select.tsx`; do not create a second Select implementation or compatibility wrapper.

The public generic composition remains:

- `Select<T, M>`,
- `SelectListBox<T>`, and
- `SelectItem`.

The field container gains consistent field spacing and relative positioning. The trigger becomes a full-width, minimum-width-zero button with text-start alignment, Vessel border/background colors, and explicit focus-visible, disabled, invalid, hover, and pressed states. `SelectValue` flexes, truncates long text, and renders placeholder text in the muted color. The chevron is decorative.

The popover has no arrow, is at least the trigger width, uses the shared Popover component, and bounds list height with scrolling. The list uses the shared DropdownListBox. Items use the existing selected check indicator and gain consistent padding, selected, hovered, focused, disabled, and text styles.

Static children, dynamic `items`, disabled items, placeholder values, descriptions, errors, and controlled/uncontrolled selection remain RAC-native.

## Stories

Add `checkbox.stories.tsx` with:

- default,
- selected,
- indeterminate,
- description,
- disabled, and
- invalid examples.

Add `checkbox-group.stories.tsx` with:

- vertical,
- horizontal,
- controlled selection, and
- required/invalid examples.

Expand `select.stories.tsx` with:

- default,
- placeholder,
- default-selected,
- controlled,
- disabled,
- invalid,
- long-option, and
- dynamic-items examples.

Stories must show real observable component states rather than duplicate equivalent markup.

## Tests

Implementation follows TDD. New observable contracts receive a failing test before production code.

Primitive tests cover:

1. Checkbox accessible name, controlled selection callback, selected and indeterminate state, description/error relationships, and disabled interaction.
2. CheckboxGroup accessible label, string-array value changes, orientation marker/layout contract, group description/error, required validation, and disabled propagation.
3. Select accessible label, placeholder/default/controlled selection, keyboard opening and option selection, description/error, disabled behavior, and dynamic items.

Migration tests cover only existing product behavior at changed call sites: exact state updates, disabled conditions, and action enablement where checkbox acknowledgements gate destructive or security-sensitive actions.

Tests assert behavior and accessibility, not implementation source text or incidental class strings unless a class is the only stable public presentation contract.

## Safe migrations in this tranche

Migrate straightforward form controls whose behavior maps directly from native boolean/string state to RAC callbacks:

- `ui/src/components/academic/ImportDialog.tsx`
  - import source Select,
  - conflict policy Select,
  - dry-run Checkbox,
  - checkpoint Checkbox.
- `ui/src/components/academic/AcademicLibrary.tsx`
  - work type Select,
  - reading status Select.
- `ui/src/components/academic/WorkDetail.tsx`
  - reading status Select,
  - annotation type Select.
- `ui/src/components/codex/EncryptionSetupDialog.tsx`
  - recovery acknowledgement Checkbox.
- `ui/src/components/codex/NoteProtectionDialog.tsx`
  - protection acknowledgement Checkbox.
- `ui/src/components/page-tree/FolderActionsMenu.tsx`
  - folder destination Select,
  - recursive deletion Checkbox.
- `ui/src/components/page-tree/PageActionsMenu.tsx`
  - inbound-link rewrite Select.

Each migration preserves option order, selected value, state transition, disabled condition, descriptive copy, and submit/action gating. Native `onChange(event)` handlers become RAC value callbacks. Native `disabled` becomes `isDisabled`; native `value` becomes `selectedKey`; native options become `SelectItem` values.

## Remaining-control inventory

The implementation deliverable includes a final ranked inventory of every remaining native checkbox and select in production TSX. Each entry must state whether it is:

- a direct future migration,
- blocked on a Switch primitive,
- blocked on row-selection or indeterminate behavior,
- blocked on DOM ref/autofocus integration,
- blocked on native multiple-select behavior,
- embedded editor content that should remain native, or
- intentionally retained for another explicit reason.

The following are explicitly outside this migration tranche:

- `Constellation` and `MobileConstellation` checkbox-backed switches,
- `Gazetteer` row-selection checkboxes,
- Slate task-list checkbox rendering,
- Bases editors whose validation focus registry stores native DOM element refs,
- inline Bases cells whose editing contract depends on native autofocus/keyboard behavior,
- native multiple-select cells.

Tasking and feed selects are inventory candidates. They are migrated only in a later tranche after their layout and interaction contracts are assessed.

## Error handling and state

These primitives add no persistence, network, retry, or telemetry behavior. Product state remains owned by existing components and hooks.

RAC `FieldError` renders validation messages. Product-level request errors remain where they are. Migrations must not convert request errors into field validation errors unless the existing code already associates the error with that field.

## Visual and interaction verification

After focused tests pass:

1. Build Storybook.
2. Open the Checkbox, CheckboxGroup, and Select stories in a real browser.
3. Exercise pointer and keyboard interaction, including focus-visible state, selection, indeterminate display, disabled controls, and Select popup navigation.
4. Inspect both base dark mode and `.paper` light mode at desktop width.
5. Smoke-test at least one migrated dialog with Select controls and one acknowledgement-gated dialog with Checkbox.

## Verification gates

Before merge:

- focused primitive tests pass,
- affected product tests pass,
- UI typecheck passes,
- UI lint passes,
- full UI test suite passes,
- Storybook build passes,
- browser smoke checks pass,
- repository typecheck/build, lint, and test gates required by project configuration pass.

## Acceptance criteria

- Shared RAC Checkbox and CheckboxGroup primitives exist and expose the approved field APIs.
- The existing shared Select is upgraded without a competing Select abstraction.
- All three primitives match Vessel styling in dark and paper modes and expose visible hover, pressed, focus-visible, disabled, selected, indeterminate, placeholder, and invalid states where applicable.
- Stories cover the approved state matrix.
- Tests defend accessibility and interaction contracts.
- Every listed safe call site uses the shared primitives with unchanged product behavior.
- Every remaining production native checkbox/select appears in the ranked inventory with a concrete disposition.
- No unrelated dirty file enters feature commits.
- Required tests, typecheck, lint, Storybook build, browser checks, and repository gates pass before merge to `develop`.
