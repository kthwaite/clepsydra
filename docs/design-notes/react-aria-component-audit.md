# React Aria Component Audit for the UI

_Date:_ 2026-04-09

## Purpose

This note audits current frontend component usage with three goals:

1. identify where visual consistency is being maintained only by repeated class strings rather than reusable components
2. identify where native interactive primitives are being used instead of `react-aria-components` (RAC)
3. define a prioritized set of core UI components to establish in `ui/src/components/ui`

The intended direction is:

- keep semantic layout and prose HTML where it makes sense (`section`, `article`, `main`, markdown content, editor document structure)
- standardize interactive primitives and composite widgets on top of `react-aria-components`
- centralize visual styling and shared business logic in a durable UI layer under `ui/src/components/ui`

## Summary

The UI is already fairly coherent at the token level, but weak at the component-system level.

### What is working well

The design tokens in `ui/src/main.css` already establish a strong and recognizable visual system:

- zero-radius brutalist geometry
- high-contrast achromatic palette
- hard-edged offset shadows
- consistent semantic tokens for `background`, `foreground`, `card`, `popover`, `border`, `muted`, `primary`, etc.
- consistent heading and mono typography choices

In practice, many screens already look related because they share these tokens.

### What is not working well

That visual consistency is being recreated manually rather than expressed through shared primitives.

Current state:

- `react-aria-components` is installed in `ui/package.json`
- there are **0 imports from `react-aria-components` in `ui/src`**
- interactive behavior is spread across hand-rolled `<button>`, `<input>`, `<select>`, `<a>`, and custom overlay implementations
- many styling patterns repeat with slight variations rather than being captured as variants on a shared component

This means the app has:

- a **consistent visual language**
- but an **inconsistent component architecture**

That is still recoverable now, but the refactor will get harder once more dialogs, menus, forms, command palettes, settings, and editor affordances are added.

## Audit scope and snapshot

Scope audited:

- `ui/src/components`
- `ui/src/editor`
- `ui/src/routes`
- excluding tests and stories

### Snapshot

- source files audited: **55**
- files with interactive primitives or routed links: **19**
- RAC imports in `ui/src`: **0**
- `ui/src/components/ui`: **does not exist yet**

### Native interactive usage found

- `<button>`: **28**
- `<input>`: **6**
- `<select>`: **1**
- `<form>`: **2**
- `<a>`: **4**
- TanStack `<Link>`: **4**

### Additional architectural observations

- `clsx` and `tailwind-merge` are installed but currently unused
- there is no shared `cn()` helper
- there is no app-wide convention for `focus-visible` treatment
- dialog, palette, and popover behavior is implemented manually in several places

## Findings

## 1. The app relies on repeated class strings rather than shared UI primitives

Repeated visual patterns appear across the codebase, but they are not centralized.

Examples of repeated patterns:

- bordered action buttons with accent hover states
- primary action buttons with `bg-primary`
- bordered cards and panels
- overlay backdrops
- popover shells
- uppercase micro-headings with wide tracking
- inline badges and chips
- bordered text inputs
- underlined inline links

These patterns are already close enough to one another that they should be expressed as component variants rather than re-authored in each feature.

## 2. Similar interactions are implemented in different ways

### Opening a page

The same "open page in workspace" action appears through several different mechanisms:

- dashboard page list in `ui/src/routes/index.tsx` uses a `<button>`
- `ui/src/components/PageList.tsx` uses TanStack `Link`
- `ui/src/components/BacklinksPanel.tsx` uses `<a>` with `preventDefault`
- `ui/src/components/TaskList.tsx` uses a `<button>`
- `ui/src/components/MarkdownRenderer.tsx` uses `<a>`
- `ui/src/components/FileTree.tsx` opens pages from a tree item primary action

This is a strong signal that the app wants a shared, business-aware primitive such as `PageLink` or `PageAction`.

### Tabs

There are currently at least two different tab implementations:

- `ui/src/routes/agenda.tsx` implements local section tabs manually
- `ui/src/components/TabBar.tsx` implements workspace tabs manually, with close buttons, context menu, and drag/drop

These should not remain unrelated patterns.

### Overlays and popups

There are multiple separate overlay or popup implementations:

- `ui/src/components/ModalDialog.tsx`
- `ui/src/components/SettingsModal.tsx`
- `ui/src/components/SearchPalette.tsx`
- `ui/src/components/TabBar.tsx` context menu
- `ui/src/editor/SlashCombobox.tsx`
- `ui/src/editor/WikilinkCombobox.tsx`
- `ui/src/editor/BlockRefCombobox.tsx`

These share visual DNA but diverge in structure, behavior, and accessibility handling.

## 3. Accessibility and interaction state are under-modeled

This is the area where RAC would help the most.

### Dialogs are hand-rolled

`ui/src/components/ModalDialog.tsx` and `ui/src/components/SettingsModal.tsx` both:

- listen for `Escape` manually
- manipulate `document.body.style.overflow` manually
- handle backdrop click dismissal manually
- set `role="dialog"` and `aria-modal="true"`

That is a reasonable stopgap, but not a durable dialog foundation. Focus containment, restore behavior, and composability should move to RAC.

### Search palette is a custom command dialog

`ui/src/components/SearchPalette.tsx` is effectively a command palette but currently combines:

- global keyboard listeners
- manual focus management
- manual overlay composition
- a raw list of result buttons

This should become a real command/dialog primitive composed from RAC building blocks.

### Editor suggestion popovers are custom list widgets

The three editor suggestion components:

- `ui/src/editor/SlashCombobox.tsx`
- `ui/src/editor/WikilinkCombobox.tsx`
- `ui/src/editor/BlockRefCombobox.tsx`

all:

- attach document-level keydown listeners
- render clickable `<div>` rows rather than proper option semantics
- duplicate a popover shell pattern
- duplicate highlighted-item styling

They should share a common popover + listbox foundation.

### Focus styling is not standardized

There is no clear shared focus-visible pattern in the current UI layer. A RAC-based primitive set should define consistent states for:

- default
- hovered
- pressed
- focused / focus-visible
- selected
- disabled

## 4. Current abstractions are mostly feature-level, not primitive-level

The codebase has reusable components, but they are largely feature or presentation components rather than durable primitives.

Examples:

- `StatCard`
- `TagCloud`
- `ThemeToggle`
- `ModalDialog`

These are useful, but they do not form a coherent UI foundation.

A strong indicator is that `SettingsModal.tsx` does not compose `ModalDialog.tsx`; it reimplements the shell. That usually means the lower-level abstraction is too narrow.

## 5. There are a few specific code smells worth addressing early

### Nested interactivity in workspace tabs

`ui/src/components/TabBar.tsx` renders a close affordance as a `span` with `role="button"` inside a `button`. This is fragile and should be replaced with a better primitive structure.

### Select remains a native one-off control

`ui/src/components/NavigationModeSelector.tsx` still uses a plain `<select>`.

For a settings surface with three options, a shared `RadioGroup` may actually fit better than `Select`.

### Editor header chips are custom and isolated

`ui/src/editor/PageEditorHeader.tsx` implements its own chip/tag input behavior. This is a good candidate for a reusable `TagInput` or tokenized field primitive later in the migration.

## What should remain native HTML

Not every HTML element needs to be replaced.

It is reasonable to keep native semantic structure for:

- `main`, `header`, `section`, `article`, `aside`, `nav`
- editor content structure rendered by Slate (`p`, `ul`, `ol`, `li`, headings, blockquotes, etc.)
- markdown document structure in `MarkdownRenderer`
- static content and read-only prose

The migration should focus on **interactive primitives and composite widgets**, not on replacing semantic structure for its own sake.

## Proposed `ui/src/components/ui` package

The new directory should contain styled primitives and a small number of business-aware wrappers.

The guiding rule should be:

- RAC for interaction and accessibility
- app tokens and variants for styling
- thin business-aware wrappers where the same domain action appears repeatedly

## Priority 0: foundational primitives

These deliver the highest leverage and should be introduced first.

### 1. `Button`

**Base:** `react-aria-components/Button`

**Why first:**

- buttons are the most repeated interactive primitive in the app
- a shared button immediately reduces class duplication and style drift
- variants can cover most existing use cases

**Recommended variants:**

- `primary`
- `secondary` or `neutral`
- `ghost`
- `quiet` or `toolbar`
- `danger`
- `tab`
- size variants like `sm`, `md`, `icon`

**Likely consumers:**

- `Sidebar.tsx`
- `journal.tsx`
- `AppLayout.tsx`
- `RouteError.tsx`
- `agenda.tsx`
- `TaskList.tsx`
- dashboard page list

### 2. `IconButton`

**Base:** `Button`

**Why first:**

Small icon-only actions appear repeatedly and should share sizing, focus, and tooltip/title conventions.

**Likely consumers:**

- dialog close buttons
- `ThemeToggle.tsx`
- journal previous / next day controls
- task state toggle controls

### 3. `Dialog` / `Modal`

**Base:** `Dialog`, `Modal`, `ModalOverlay`

**Why first:**

The app already has multiple dialogs and overlays with duplicated keyboard and backdrop logic.

**Should provide:**

- overlay shell
- panel shell
- title / description slots
- close affordance
- size variants
- optional footer slot

**Likely consumers:**

- `ModalDialog.tsx`
- `SettingsModal.tsx`
- `SearchPalette.tsx`

### 4. `TextField`

**Base:** `TextField`, `Label`, `Input`, `FieldError`

**Why first:**

The app already has multiple bordered inputs and input-like fields. Standardizing them now will prevent rapid drift.

**Should provide:**

- label
- description
- error text
- disabled state
- consistent ring / focus-visible styling
- variants for standard field and inline / chrome-less field

**Likely consumers:**

- create note / folder path in `Sidebar.tsx`
- quick capture input in `journal.tsx`
- title and token input support in `PageEditorHeader.tsx`

### 5. `SearchField`

**Base:** `SearchField`, `Input`

**Why first:**

The command/search UI should not remain a one-off control.

**Likely consumers:**

- `SearchPalette.tsx`
- future search surfaces and inline filters

### 6. `PageLink`

**Base:** RAC `Link` or a button-like wrapper, depending on use case

**Why first:**

This centralizes the domain-specific “open page in workspace” action that currently appears in many unrelated implementations.

**Should handle:**

- opening a page tab via `useOpenTab`
- optional display of path vs title
- internal vs external style behavior where needed

**Likely consumers:**

- `PageList.tsx`
- `BacklinksPanel.tsx`
- `TaskList.tsx`
- `MarkdownRenderer.tsx`
- `routes/index.tsx`
- possibly parts of `FileTree.tsx`

### 7. `Menu` / `PopoverMenu`

**Base:** `MenuTrigger`, `Popover`, `Menu`, `MenuItem`

**Why first:**

There is already a custom context menu in the workspace tabs, and more menus are likely.

**Likely consumers:**

- `TabBar.tsx`
- future row actions, settings menus, command actions

## Priority 1: shared composite primitives

These should follow once the foundations are in place.

### 8. `Tabs`

**Base:** `Tabs`, `TabList`, `Tab`, `TabPanel`

**Use first in:**

- `ui/src/routes/agenda.tsx`

This should inform, though not necessarily directly replace, the more specialized workspace tab system.

### 9. `Select` and/or `RadioGroup`

**Base:** `Select`, `SelectValue` and/or `RadioGroup`, `Radio`

**Recommendation:**

For `NavigationModeSelector.tsx`, a `RadioGroup` is probably better than a select. The setting is small, always visible, and should be easy to scan.

### 10. `ListBox` / `CommandList`

**Base:** `ListBox`, `ListBoxItem`, `Popover`

**Use for:**

- command/search result lists
- suggestion popovers
- settings pickers

This is especially important for aligning search palette and editor suggestion UI.

### 11. `Checkbox` and business-aware toggles

**Base:** `Checkbox`

**Use for:**

- settings controls
- task-style state toggles where a simple checkbox is appropriate

In some places, especially `TaskList.tsx`, a business-specific `TaskStatusButton` may be more appropriate than a generic checkbox.

### 12. `Card`

**Base:** styled wrapper

**Use for:**

- settings cards
- stats cards
- error detail panels
- secondary content panels

### 13. `Badge` / `Tag`

**Base:** styled wrapper or RAC tag primitives where appropriate

**Use for:**

- `TagCloud.tsx`
- task metadata badges
- page header chips
- “Coming Soon” status indicators

### 14. `SectionHeading`

**Base:** styled heading helper

This is a small primitive, but it appears often enough to be worth centralizing.

### 15. `EmptyState` / `StatusMessage`

**Base:** styled wrapper

Use for repeated loading, empty, and minor error states.

## Priority 2: business-aware composites

These are valuable but should be built after the foundation is stable.

### 16. `CommandPalette`

**Composition:** `Dialog` + `SearchField` + `ListBox`

**Target:** replace `ui/src/components/SearchPalette.tsx`

### 17. `SettingsDialog`

**Composition:** `Dialog` + `Tabs` or `ListBox` + `RadioGroup`

**Target:** replace `ui/src/components/SettingsModal.tsx`

### 18. `TagInput`

**Composition:** `TagGroup` / `TagList` + `Input`

**Target:** replace chip editing logic in `ui/src/editor/PageEditorHeader.tsx`

### 19. `WorkspaceTabs`

**Composition:** likely custom around RAC primitives

This area includes drag/drop, close actions, active state, and a context menu. It is high value, but should not be the first migration because it is more behaviorally complex.

### 20. `EditorSuggestionPopover`

**Composition:** `Popover` + `ListBox`

**Target:** unify:

- `SlashCombobox.tsx`
- `WikilinkCombobox.tsx`
- `BlockRefCombobox.tsx`

### 21. `SidebarTree`

**Composition:** evaluate carefully

The current tree uses `@headless-tree`. RAC does export tree primitives, but this should not be migrated prematurely if it risks losing features or behavior. It is acceptable to keep `@headless-tree` while still standardizing the surrounding visual language.

## Recommended first-pass file tree

A reasonable starting structure for `ui/src/components/ui` would be:

```text
ui/src/components/ui/
  badge.tsx
  button.tsx
  card.tsx
  dialog.tsx
  icon-button.tsx
  menu.tsx
  page-link.tsx
  radio-group.tsx
  search-field.tsx
  tabs.tsx
  text-field.tsx
  list-box.tsx
  section-heading.tsx
  status-message.tsx
  utils.ts
```

Where `utils.ts` should expose a shared `cn()` helper backed by `clsx` and `tailwind-merge`.

## Files with the highest immediate standardization value

These files should be treated as high-value migration targets because they combine repeated styling with repeated interaction patterns.

### Highest priority

- `ui/src/components/Sidebar.tsx`
- `ui/src/routes/journal.tsx`
- `ui/src/components/AppLayout.tsx`
- `ui/src/components/ModalDialog.tsx`
- `ui/src/components/SettingsModal.tsx`
- `ui/src/components/SearchPalette.tsx`

### Next priority

- `ui/src/routes/agenda.tsx`
- `ui/src/components/TaskList.tsx`
- `ui/src/components/RouteError.tsx`
- `ui/src/editor/PageEditorHeader.tsx`
- `ui/src/components/TabBar.tsx`

### Later / more specialized

- `ui/src/editor/SlashCombobox.tsx`
- `ui/src/editor/WikilinkCombobox.tsx`
- `ui/src/editor/BlockRefCombobox.tsx`
- `ui/src/components/FileTree.tsx`

## Conclusions

The UI is at a good point to introduce a proper component layer.

### Bottom line

- the visual system is already mostly coherent
- the interaction layer is not yet coherent
- RAC is available but unused
- a `ui/src/components/ui` package should now become the default home for shared interactive primitives

### Recommended policy going forward

For new UI work:

- use `react-aria-components` for interactive primitives and composite widgets
- use `ui/src/components/ui` primitives instead of raw `<button>`, `<input>`, `<select>`, and custom overlay shells wherever feasible
- only use raw primitives directly when there is a strong editor-specific or structural reason

The next document should turn this audit into a phased migration plan.
