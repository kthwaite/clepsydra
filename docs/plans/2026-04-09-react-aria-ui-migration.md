# React Aria UI Migration Plan

_Date:_ 2026-04-09

## Context

This plan follows the audit in [`docs/design-notes/react-aria-component-audit.md`](../design-notes/react-aria-component-audit.md).

The goal is to establish a durable UI foundation under `ui/src/components/ui` using `react-aria-components` (RAC), while preserving the existing brutalist visual language and avoiding unnecessary churn in editor- and tree-specific code.

## Goals

1. migrate the app toward RAC-backed interactive primitives
2. reduce duplicated class strings and one-off interaction logic
3. centralize visual variants and a small amount of shared business logic in `ui/src/components/ui`
4. improve accessibility of dialogs, menus, tabs, lists, and fields
5. keep the refactor incremental, low-risk, and easy to review

## Non-goals

This plan does **not** aim to:

- replace every semantic HTML element with a component
- rewrite the Slate editor itself
- immediately replace `@headless-tree` with RAC tree primitives
- redesign the visual system in `ui/src/main.css`

The focus is the interaction layer and the shared component system.

## Working principles

### 1. Migrate by shared primitives first

Do not start by rewriting large feature components in place.

Instead:

- build shared primitives in `ui/src/components/ui`
- migrate the most duplicated call sites first
- let feature components collapse naturally onto the new foundation

### 2. Preserve semantic layout HTML

Keep native HTML for structural content where that remains the clearest expression:

- `main`, `header`, `section`, `article`, `aside`, `nav`
- markdown-rendered prose structure
- Slate content structure

### 3. Use RAC where interaction and accessibility matter

RAC should become the default for:

- buttons
- dialogs / modals
- menus / popovers
- fields
- search inputs
- tabs
- listbox-style collections
- checkbox / radio / switch style controls

### 4. Avoid over-generalizing too early

Start with components that already have obvious repetition in the codebase.

A component should be added to `ui/src/components/ui` when at least one of these is true:

- the same visual pattern appears in several files
- the same interaction pattern appears in several files
- the same domain action appears in several files
- accessibility is difficult to get right ad hoc

### 5. Prefer thin business-aware wrappers where the app already wants them

Not every shared component has to be a pure visual primitive.

Examples that are worth encapsulating:

- `PageLink`
- `TaskStatusButton`
- `CommandPalette`
- `SettingsDialog`

## Target component set

## Phase 0 deliverables: shared infrastructure

Before migrating features, establish the base utilities and conventions.

### Deliverables

- `ui/src/components/ui/` directory
- `ui/src/components/ui/utils.ts`
- a `cn()` helper backed by `clsx` and `tailwind-merge`
- component naming and export conventions
- a small Storybook surface for new primitives if practical

### Conventions

- all interactive primitives accept `className`
- all primitives expose meaningful variants rather than arbitrary repeated class strings
- tokens continue to come from `ui/src/main.css`
- data/state styling should prefer RAC state hooks / render props / data attributes over manual class string duplication

## Phase 1: foundational primitives

These should be built first because they unlock the highest-value migrations.

### 1. `Button`

**Base:** `react-aria-components/Button`

**Minimum API:**

- `variant`: `primary | secondary | ghost | quiet | danger | tab`
- `size`: `sm | md | icon`
- `isDisabled`
- `className`

**Must support current use cases:**

- primary action buttons
- toolbar buttons
- quiet row actions
- tab-like triggers
- destructive/critical actions

### 2. `IconButton`

**Base:** wraps `Button`

**Minimum API:**

- `label` or `aria-label` required
- standard icon sizing and padding
- variants that align with toolbar and close-button use cases

### 3. `Dialog`

**Base:** `Dialog`, `Modal`, `ModalOverlay`

**Minimum API:**

- `isOpen`
- `onOpenChange`
- `title`
- optional `description`
- optional `footer`
- size variants such as `sm | md | lg | xl`
- optional close button

**Should standardize:**

- backdrop styling
- panel styling
- title/description spacing
- close affordance
- footer layout

### 4. `TextField`

**Base:** `TextField`, `Label`, `Input`, `FieldError`

**Minimum API:**

- `label`
- optional `description`
- optional `errorMessage`
- `isDisabled`
- variants for standard and chrome-less/inline appearance

### 5. `SearchField`

**Base:** `SearchField`, `Input`

**Minimum API:**

- optional leading icon slot
- placeholder
- keyboard hint slot if needed
- controlled value support

### 6. `Menu`

**Base:** `MenuTrigger`, `Popover`, `Menu`, `MenuItem`

**Minimum API:**

- menu trigger wrapper
- action items
- shared popover shell
- destructive item styling

### 7. `PageLink`

**Base:** thin business-aware wrapper

**Minimum API:**

- `path`
- optional `label`
- optional visual variant
- default behavior opens the page in the workspace via `useOpenTab`

This is intentionally app-specific and should live beside the other UI primitives.

## Phase 2: migrate the highest-value feature surfaces

After the core primitives exist, migrate the feature files that currently contain the highest amount of duplicated interaction code.

## 2A. Dialogs and overlays

### Targets

- `ui/src/components/ModalDialog.tsx`
- `ui/src/components/SettingsModal.tsx`
- `ui/src/components/SearchPalette.tsx`

### Plan

1. replace `ModalDialog.tsx` internals with the new shared `Dialog`
2. collapse `SettingsModal.tsx` onto the same dialog shell rather than maintaining a custom modal structure
3. replace `SearchPalette.tsx` with a command-dialog composition built from `Dialog` + `SearchField` + a list primitive

### Expected benefits

- one source of truth for overlay styling
- better accessibility and focus handling
- removal of duplicated escape/backdrop/body-scroll logic

## 2B. Buttons and fields

### Targets

- `ui/src/components/Sidebar.tsx`
- `ui/src/routes/journal.tsx`
- `ui/src/components/AppLayout.tsx`
- `ui/src/components/RouteError.tsx`

### Plan

Replace raw buttons and fields with:

- `Button`
- `IconButton`
- `TextField`
- `PageLink` where appropriate

### Notes by file

#### `Sidebar.tsx`

Replace:

- modal footer action buttons
- new note / new folder buttons
- settings button
- create-path input field

Potential end state:

- `Dialog`
- `Button`
- `TextField`
- shared nav/link row styling where useful

#### `journal.tsx`

Replace:

- previous / next day controls with `IconButton`
- today action with `Button`
- quick capture input with `TextField` or an inline field variant
- capture submit with `Button`
- recent journal row buttons with a shared row-button pattern or list-item primitive

#### `AppLayout.tsx`

Replace:

- search trigger button
- theme toggle button usage

Potential end state:

- `Button` for search trigger
- `IconButton` for theme toggle

#### `RouteError.tsx`

Replace recovery actions with `Button` variants and standardize card/panel structure.

## Phase 3: collections, tabs, and settings controls

Once dialogs, buttons, and fields are in place, migrate collection-style controls.

### 8. `Tabs`

**Target first:** `ui/src/routes/agenda.tsx`

The agenda page should become the proving ground for the shared tab primitive.

This is a low-risk place to establish:

- tab trigger styling
- selected state styling
- keyboard navigation expectations
- panel spacing conventions

### 9. `RadioGroup` or `Select`

**Target first:** `ui/src/components/NavigationModeSelector.tsx`

Recommended path:

- use a `RadioGroup` in settings rather than a select
- only build a shared `Select` early if another actual use case appears

### 10. `Card`, `Badge`, `SectionHeading`, `StatusMessage`

These are lower-complexity wrappers that should be introduced once the higher-value interactive primitives are in use.

Targets include:

- `StatCard.tsx`
- `TagCloud.tsx`
- settings cards in `SettingsModal.tsx`
- task metadata in `TaskList.tsx`
- repeated section headings in agenda, journal, sidebar, and error views

## Phase 4: business-aware composites

These components should be built once the primitive layer has proven stable.

### 11. `CommandPalette`

**Target:** `ui/src/components/SearchPalette.tsx`

**Composition:**

- `Dialog`
- `SearchField`
- `ListBox` or command-list primitive

This should replace the current custom open/close/input/list implementation.

### 12. `SettingsDialog`

**Target:** `ui/src/components/SettingsModal.tsx`

**Composition options:**

- `Dialog` + `Tabs`
- or `Dialog` + left-nav list + content panel

The exact composition can remain app-specific, but the shell and controls should come from shared primitives.

### 13. `TagInput`

**Target:** `ui/src/editor/PageEditorHeader.tsx`

**Composition:**

- inline input
- removable tokens or RAC tag primitives

This should replace the custom chip editing implementation once the core field patterns are stable.

### 14. `TaskStatusButton`

**Target:** `ui/src/components/TaskList.tsx`

This should likely be a business-aware component rather than a generic checkbox, since the current interaction cycles domain-specific task states.

## Phase 5: advanced/editor-adjacent surfaces

These are important, but should come after the primitives are stable and already in use elsewhere.

### 15. editor suggestion popovers

### Targets

- `ui/src/editor/SlashCombobox.tsx`
- `ui/src/editor/WikilinkCombobox.tsx`
- `ui/src/editor/BlockRefCombobox.tsx`

### Plan

Create an `EditorSuggestionPopover` or `CommandList`-style foundation that standardizes:

- shell styling
- active option styling
- list semantics
- keyboard behavior where feasible

### Caution

Do not force editor-specific trigger and selection behavior into an over-general abstraction too early. Shared shell and list behavior is the right initial target.

### 16. workspace tabs

**Target:** `ui/src/components/TabBar.tsx`

This is a more complex component because it includes:

- active tab state
- close actions
- middle-click close
- drag-and-drop reordering
- context menu actions

It should be migrated later, not because it is unimportant, but because it deserves a careful, dedicated design.

### 17. file tree

**Target:** `ui/src/components/FileTree.tsx`

This should be evaluated separately.

Recommended near-term approach:

- keep `@headless-tree`
- standardize row/button styling around shared UI primitives where practical
- only consider a RAC tree migration if there is a clear payoff and no loss of behavior

## Proposed migration sequence by file

This sequence is intended to maximize value while minimizing regressions.

### Sequence A: foundation

1. create `ui/src/components/ui/utils.ts`
2. create `ui/src/components/ui/button.tsx`
3. create `ui/src/components/ui/icon-button.tsx`
4. create `ui/src/components/ui/dialog.tsx`
5. create `ui/src/components/ui/text-field.tsx`
6. create `ui/src/components/ui/search-field.tsx`
7. create `ui/src/components/ui/menu.tsx`
8. create `ui/src/components/ui/page-link.tsx`

### Sequence B: immediate adopters

9. migrate `ui/src/components/ModalDialog.tsx`
10. migrate `ui/src/components/Sidebar.tsx`
11. migrate `ui/src/components/AppLayout.tsx`
12. migrate `ui/src/routes/journal.tsx`
13. migrate `ui/src/components/RouteError.tsx`

### Sequence C: overlays and settings

14. migrate `ui/src/components/SearchPalette.tsx`
15. migrate `ui/src/components/NavigationModeSelector.tsx`
16. migrate `ui/src/components/SettingsModal.tsx`

### Sequence D: collections and small repeated surfaces

17. create `ui/src/components/ui/tabs.tsx`
18. migrate `ui/src/routes/agenda.tsx`
19. create `ui/src/components/ui/card.tsx`
20. create `ui/src/components/ui/badge.tsx`
21. migrate `ui/src/components/TaskList.tsx`
22. migrate `ui/src/components/StatCard.tsx`
23. migrate `ui/src/components/TagCloud.tsx`
24. migrate repeated headings and status text patterns where useful

### Sequence E: specialized surfaces

25. create editor suggestion foundation
26. migrate the three editor comboboxes
27. design and migrate `TabBar.tsx`
28. review `FileTree.tsx`
29. review `PageEditorHeader.tsx` for `TagInput`

## Acceptance criteria by phase

## Phase 1 acceptance criteria

- `ui/src/components/ui` exists and is being used
- at least `Button`, `IconButton`, `Dialog`, `TextField`, and `PageLink` exist
- new primitives use RAC under the hood where applicable
- `cn()` helper is adopted
- no new raw interactive primitives are introduced in migrated files without justification

## Phase 2 acceptance criteria

- `ModalDialog.tsx` and `SettingsModal.tsx` share the same dialog foundation
- `SearchPalette.tsx` no longer uses a bespoke overlay shell
- high-traffic screens (`Sidebar`, `journal`, `AppLayout`) primarily use shared buttons and fields

## Phase 3 acceptance criteria

- `Agenda` uses shared tabs
- navigation mode control uses a shared settings control rather than a bespoke native select
- badges/cards/section headings are no longer re-authored manually in multiple files

## Phase 4 acceptance criteria

- command palette and settings surfaces are composed from shared primitives
- page-opening actions use a consistent `PageLink`/page-action approach
- task state toggles and tokenized tag editing have clear homes in the UI layer

## Phase 5 acceptance criteria

- editor suggestion popovers share a single shell and list treatment
- workspace tabs no longer rely on nested-interactive hacks
- tree migration decision is documented explicitly rather than left implicit

## Review checkpoints

At the end of each phase, review:

1. whether class duplication decreased materially
2. whether the resulting abstractions actually simplified call sites
3. whether a11y improved, especially around keyboard and focus behavior
4. whether the component API is staying smaller and cleaner than the raw repeated code it replaced

If a primitive becomes harder to use than the previous direct markup, stop and simplify it before broad adoption.

## Risks and mitigations

### Risk: over-abstracting too soon

**Mitigation:**

- only extract primitives with proven repetition
- keep APIs small
- avoid giant kitchen-sink components

### Risk: breaking editor-specific interactions

**Mitigation:**

- defer deep editor changes until late
- start with shared popover/list shells, not a full editor UI rewrite

### Risk: workspace tabs become a refactor sink

**Mitigation:**

- migrate simple tabs first in `agenda.tsx`
- treat workspace tabs as a dedicated design task later

### Risk: tree migration churn without payoff

**Mitigation:**

- keep `@headless-tree` unless RAC tree is clearly superior for actual requirements

## Immediate next step

Implementation should begin with the Phase 1 foundation in `ui/src/components/ui`.

If work is split into small PRs, the recommended first PR is:

1. add `cn()`
2. add `Button`
3. add `IconButton`
4. migrate the easiest call sites in `AppLayout.tsx` and `RouteError.tsx`

That gives the project a real UI foundation without immediately taking on dialogs, search, or tabs.
