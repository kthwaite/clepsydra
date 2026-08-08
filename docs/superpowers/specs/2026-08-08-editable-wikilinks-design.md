# Editable Wikilinks Design

## Goal

Make wikilinks display only their custom label when one exists, while allowing keyboard-first editing of a completed wikilink without sacrificing the existing `[[` page-search and Tab-completion flow.

## Current behavior

Wikilinks are Slate `inline-void` elements containing stable `target` and optional `alias` properties. The renderer currently shows both values as `⟦ target · alias ⟧`. Tab completion inserts an atomic target-only node and places the Slate caret after it. Markdown loading, saving, link resolution, and rename rewriting already preserve `[[Target|Label]]` correctly.

Directly typed complete wikilinks are converted into the same atomic node by the inline autoformatter.

## Decisions

- A passive labeled wikilink displays only its alias: `⟦Label⟧`.
- A passive unlabeled wikilink displays its target: `⟦Target⟧`.
- The underlying Slate node remains `inline-void`; editing uses a temporary inline text control rather than changing the persisted node shape.
- The active editing text is source-like content without Markdown delimiters: `Target` or `Target|Label`. The existing ornamental brackets remain visible.
- Plain click enters editing. Cmd-click on macOS and Ctrl-click elsewhere opens the linked page.
- Arrow-right from immediately before the node enters at the start. Arrow-left from immediately after the node enters at the end.
- This makes the post-completion flow: Tab to accept a target, Left to enter it, then type `|Label`.
- Leaving through an arrow boundary, Enter, or outside click commits the current valid value. Escape cancels instead of committing.
- Cmd/Ctrl+Enter commits a valid draft and opens its target; an invalid draft remains active and does not navigate.
- Empty target input is invalid and restores the pre-edit value.
- An empty alias removes the alias.
- An alias may contain additional pipe characters; only the first pipe separates target from alias.
- One completed edit session is one undoable Slate operation.

## Architecture

### Persisted model

Keep the existing wikilink node:

```ts
{
  type: "wikilink",
  target: string,
  alias?: string,
  children: [{ text: "" }]
}
```

No Markdown, API, index, or backend schema changes are required.

### Edit-session controller

Add an editor plugin responsible for atomic-wikilink entry and exit. It owns only selection transitions:

- Detect Left/Right at a selection immediately adjacent to a wikilink.
- Mark that wikilink as the active edit target and specify the initial caret edge.
- On commit, apply one `Transforms.setNodes` operation to update `target` and `alias`.
- Restore the Slate selection immediately before or after the atomic node when the inline control exits through a boundary.

The active edit identity and draft text are transient UI state, not serialized Slate properties. The renderer receives edit-session state through a narrowly scoped React context mounted by `SlateEditor`.

### Wikilink renderer

`WikilinkElement` has two modes:

- **Passive:** render one visible value, preferring `alias` over `target`. Preserve resolved/dangling styling and ornamental brackets.
- **Active:** render the same brackets around a focused inline text control initialized from `target` and `alias`. Suppress link navigation while editing.

The inline control reports commit, cancel, and boundary exit to the edit-session controller. It does not directly mutate the Slate document per keystroke.

### Navigation

Passive plain click starts editing. Modifier-click uses the existing resolved/dangling navigation flow. For dangling links, modifier-click retains the existing refetch, exact-title lookup, create, and open sequence.

While active, pointer navigation is disabled. Cmd/Ctrl+Enter provides keyboard navigation by committing a valid draft and opening its target.

## Data flow

1. `[[` opens the existing page dropdown.
2. Tab completion inserts `{ target, alias: undefined }` and moves Slate selection after the node.
3. Left detects the adjacent wikilink and starts an edit session at the end of `Target`.
4. The inline control receives `|Label` and holds `Target|Label` as local draft text.
5. A commit parses the first pipe, validates the target, and performs one Slate node update.
6. The passive renderer displays `Label` only.
7. Markdown serialization writes `[[Target|Label]]` through the existing converter.

Directly typed `[[Target|Label]]` continues to autoformat into the same node and immediately uses passive alias-only rendering.

## Validation and error handling

- Trim neither target nor alias silently; user-entered text is preserved.
- A target whose trimmed value is empty cannot commit. Boundary exit or outside click restores the original value.
- A missing pipe produces an unlabeled link.
- A present pipe with an empty alias removes the alias.
- Escape always restores the original target and alias.
- Resolution refresh follows normal page save/index behavior; the edit control does not issue searches or writes.

## Accessibility

- The active inline control has an accessible label such as `Edit wikilink`.
- Passive links expose only the visible label as their accessible name.
- Cmd/Ctrl+Enter in the active control provides a keyboard-equivalent navigation gesture.
- Focus restoration must be deterministic on commit and cancel.

## Testing

### Renderer contracts

- Resolved and dangling labeled wikilinks show the alias and do not render the target as visible text.
- Unlabeled wikilinks show the target.
- Plain click requests editing; Cmd/Ctrl-click retains navigation behavior.

### Edit-session contracts

- Right from before enters at offset zero.
- Left from after enters at the end.
- Boundary arrows commit and restore Slate selection on the corresponding side.
- Enter and outside click commit.
- Cmd/Ctrl+Enter commits a valid draft and opens its target.
- Escape cancels.
- Empty target restores the original node.
- Empty alias removes `alias`.
- Only the first pipe is structural.
- A complete session produces one undo step.

### End-to-end editor contracts

- Tab-complete target, Left, type `|Label`, exit: passive output shows only `Label`.
- Directly typed `[[Target|Label]]` shows only `Label` after autoformat.
- Save and reload round-trip remains `[[Target|Label]]`.
- Modifier-click opens resolved links and preserves dangling-link creation behavior.

## Non-goals

- Changing Markdown wikilink syntax.
- Adding alias entry to the completion dropdown itself.
- Backend, index, or rename-rewriter changes.
- Nested formatting inside labels.
- Multiple simultaneous wikilink edit sessions.
