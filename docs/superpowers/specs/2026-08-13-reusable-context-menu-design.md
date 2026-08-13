# Reusable React Aria Context Menu Design

**Date:** 2026-08-13
**Status:** Approved for implementation planning

## Goal

Replace the hand-rolled SHEAF context menu infrastructure with a reusable React Aria Components menu primitive. Preserve existing workspace actions while adding reusable accessibility and composition capabilities for future row, settings, and command-action menus.

This change adds primitive capabilities, not new workspace business actions.

## Project scan

The live UI contains one context-menu implementation:

- `ui/src/components/codex/SheafContextMenu.tsx` implements a fixed portal, coordinate clamping, Escape and outside-mousedown listeners, action rows, separators, inline name inputs, and a quire color control.
- `ui/src/components/codex/Sheaf.tsx` owns context-menu target state and three manual `onContextMenu` handlers for tabs and quire headers.

The React Aria audit mentions future row-action, settings, and command-action menus, but no implementations are deferred elsewhere. References to `ui/src/components/TabBar.tsx` are stale; `Sheaf.tsx` is the current workspace tab surface.

The following similarly named or adjacent components are not context menus and remain unchanged:

- `ui/src/components/page-tree/PageActionsMenu.tsx`: inline action launchers plus safety dialogs.
- `ui/src/components/page-tree/FolderActionsMenu.tsx`: a dialog launcher for folder management.
- `ui/src/components/tasking/InlineEditPopover.tsx`: an interactive form popover.
- Existing selects, comboboxes, listboxes, dialogs, and the command palette.

## Decision

Create thin, composable wrappers around React Aria Components rather than an item-array schema or a custom headless controller.

Composition preserves RAC's native collection, selection, and submenu APIs. It also avoids inventing a second declarative language that would need to model icons, descriptions, disabled items, selection state, sections, and nested menus. A custom controller would duplicate positioning, focus, keyboard, and dismissal behavior that RAC already provides.

## Shared primitive

Create `ui/src/components/ui/menu.tsx`. It exports styled wrappers for:

- `MenuTrigger` for ordinary press-triggered menus.
- `ContextMenuTrigger`, fixed to `trigger="contextMenu"` and wrapping its native trigger child with RAC `Pressable` without adding a DOM node.
- `Menu`.
- `MenuItem`.
- `MenuSection`.
- `MenuSeparator`.
- `SubmenuTrigger`.
- A keyboard-shortcut presentation slot.

The wrappers use the existing shared `ui/src/components/ui/popover.tsx` shell. They import no application stores or domain types.

Representative use:

```tsx
<ContextMenuTrigger>
  <Target />
  <Menu aria-label="Folio actions" onAction={handleAction}>
    <MenuItem id="close" shortcut="⌘W">
      Close
    </MenuItem>
    <MenuSeparator />
    <SubmenuTrigger>
      <MenuItem>Add to quire</MenuItem>
      <Menu aria-label="Add to quire">
        <MenuItem id="quire:thesis" swatch="var(--quire-sepia)">
          Thesis
        </MenuItem>
      </Menu>
    </SubmenuTrigger>
    <MenuItem id="delete" variant="destructive">
      Delete
    </MenuItem>
  </Menu>
</ContextMenuTrigger>
```

### Public capabilities

`MenuItem` supports:

- default and destructive visual variants;
- an optional icon or color swatch;
- label and optional description content;
- an optional keyboard shortcut;
- RAC disabled state;
- selected indicators appropriate to single- and multiple-selection menus;
- automatic submenu indication when it is a submenu trigger.

The wrappers preserve RAC's native `disabledKeys`, `selectionMode`, `selectedKeys`, `onSelectionChange`, `onAction`, and collection APIs. They do not re-model those APIs with project-specific types.

RAC owns:

- positioning at the context-click point;
- viewport collision handling and portal behavior;
- outside dismissal and focus restoration;
- typeahead, arrow-key navigation, activation, and Escape handling;
- right-click, touch long-press, and platform or assistive-technology context-menu shortcuts;
- submenu focus and hover behavior.

## SHEAF integration

The shared primitive remains presentation- and interaction-only. SHEAF-specific action construction continues to read the workspace store and invoke workspace actions.

### Tab menu

The tab menu contains:

1. Close.
2. Close others.
3. A separator.
4. New quire…
5. An `Add to quire` submenu when another quire exists.
6. Remove from quire when the tab belongs to one.

The `Add to quire` submenu replaces the current unbounded flat list of `ADD TO …` rows.

### Quire menu

The quire menu contains:

1. Rename…
2. A `Color` submenu containing all six quire colors.
3. Expand or Collapse.
4. A separator.
5. Ungroup.
6. Close quire, using the destructive variant.

The color submenu uses single selection. Each item shows its swatch and selected state. This replaces the nonstandard nested button group inside the current menu.

### Naming flows

Selecting `New quire…` or `Rename…` closes the menu and opens a compact controlled RAC `Dialog` containing the shared `TextField`. Enter commits a non-empty trimmed name; Escape or Cancel dismisses without mutation.

Inputs are not embedded in the `role="menu"` collection. This is a deliberate accessibility and interaction correction from the current mixed menu/form semantics.

### Trigger wiring and drag-and-drop

`Sheaf.tsx` no longer owns `{x, y}` coordinates or a global menu target. Each tab and quire target is associated with a `ContextMenuTrigger`.

The existing draggable and drop-target DOM elements retain their refs and layout. The menu trigger must not add a layout box or move a pragmatic-drag-and-drop ref to a wrapper. Right-clicking a tab or quire remains a single-gesture retarget: RAC dismisses the old menu and opens the new target's menu from the same interaction.

`ContextMenuTrigger` splits its trigger and menu children, wraps the native trigger element in RAC `Pressable`, and passes both to RAC `MenuTrigger`. `Pressable` consumes RAC's press-responder context while preserving the existing DOM and forwarded ref. The pragmatic-drag-and-drop refs therefore remain on the current tab and quire elements; no manual global listeners or coordinate state are retained.

## State and error behavior

- Menu open state is owned by RAC unless the naming-dialog handoff requires a narrowly controlled transition.
- Business actions continue to use `useWorkspaceStore.getState()` at activation time so an action does not capture stale tab or quire data.
- If a tab or quire disappears before activation, its action is a no-op and the menu closes.
- Naming dialogs validate a trimmed non-empty string. Existing store normalization remains authoritative.
- The primitive does not catch business-action errors or add notifications; current workspace actions are synchronous and non-throwing.

## Styling

The root menu retains the current SHEAF visual language:

- `cl-mono` typography;
- paper background and ink border;
- uppercase 10px labels with current tracking;
- approximately 220px width for SHEAF menus;
- ink-on-paper default state and paper-on-ink focused/hovered state;
- rule-soft separators;
- muted disabled items;
- destructive token for destructive items when not focused;
- visible selected indicators and submenu chevrons.

Width is consumer-configurable through `className`; the shared primitive does not hard-code SHEAF's width for every future menu.

## Verification

### Primitive component tests

- Open from a context-menu pointer event and invoke an action.
- Open from the supported keyboard context-menu gesture, navigate, and invoke an action.
- Escape closes and restores focus.
- Disabled items cannot activate.
- Destructive items expose the intended styling state.
- Single- and multiple-selection items render and update selected state.
- Submenus open and support keyboard traversal.
- Sections, separators, icons or swatches, descriptions, and shortcuts render with correct semantics.

### SHEAF component tests

- Preserve Close and Close others behavior.
- Create a quire through the naming dialog.
- Add a tab to a quire through the submenu.
- Remove a tab from a quire.
- Rename a quire through the naming dialog.
- Select and expose the current quire color through the color submenu.
- Expand or collapse, ungroup, and close a quire.
- Handle a target removed while its menu is open.

### Runtime smoke test

In the actual UI:

- right-click tabs and quire labels, including retargeting while a menu is open;
- open near each viewport edge and confirm collision handling;
- open and operate the menu from the keyboard;
- emulate touch long-press;
- drag and reorder tabs before and after using a menu;
- verify focus returns to the invoking target after dismissal.

Then run the repository-required UI typecheck, lint, and full test suite.

## Replacement list

The implementation directly replaces:

1. The hand-rolled portal, viewport math, global listeners, `Row`, and `Divider` inside `ui/src/components/codex/SheafContextMenu.tsx`.
2. The context-menu coordinate and target state in `ui/src/components/codex/Sheaf.tsx`.
3. The three manual `onContextMenu` openings in `Sheaf.tsx`.
4. The flat `ADD TO …` quire rows with a submenu.
5. The quire color `role="group"` and nested menuitem buttons with a single-selection color submenu.
6. The inline menu `NameInput` with compact naming dialogs.

No other existing component is replaced in this pass. The primitive enables later row-action, settings-overflow, and command-action menus without preemptively changing those surfaces.
