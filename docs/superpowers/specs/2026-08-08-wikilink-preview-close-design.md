# Wikilink Preview Close Design

## Goal

When a user activates a resolved internal wikilink, close every preview window for that link's exact vault path before opening the destination page.

## Current behavior

`CLink` opens path-backed internal links through `useOpenTab`. Hover previews are managed separately by `usePreviewStore`, so opening a link leaves its matching preview visible. The store already owns window removal, hover identity, and persisted pinned-window state, but it can only close by window ID.

## Design

Add a `closePath(path)` action to the preview store. The action removes every window whose `path` exactly matches the supplied vault path, regardless of whether the window is transient, pinned, or minimized. It clears `hoverId` when the transient hover window was among those removed and persists the remaining pinned windows.

`CLink` will select `closePath` from the preview store. Its default path-backed click handler will call `closePath(path)` immediately before `openTab("page", path)`. The existing behavior remains unchanged when `onClick` overrides navigation, when `noNavigate` is set, or when a link has no vault path.

Exact path matching is intentional: clicking one internal link must not close previews for other pages.

## Alternatives rejected

- Mutating preview state directly from `CLink` would duplicate the store's persistence and hover-state invariants.
- Closing previews inside `useOpenTab` would affect every page-opening control, not only path-backed internal links, and is wider than the requested behavior.

## Error handling

Closing an absent path is an idempotent no-op. Navigation proceeds normally. Persisted pinned state is updated through the same best-effort local-storage behavior used by the existing `close(id)` action.

## Verification

Use TDD:

1. Add store tests proving `closePath` removes matching transient, pinned, and minimized windows, preserves unrelated windows, clears a matching `hoverId`, and updates persisted pinned state.
2. Add a `CLink` interaction test proving a path-backed click removes the matching preview and opens the page while leaving unrelated previews intact.
3. Run the focused tests red, implement the minimal change, then rerun them green.
4. Run UI typecheck, lint, and the full UI test suite.
5. Exercise the behavior in the running UI: open a wikilink preview, click the wikilink, and observe that the destination opens while its preview disappears.

## Non-goals

- Changing hover timing or preview placement.
- Closing unrelated preview windows.
- Changing custom `CLink` click handlers or dangling-wikilink creation behavior.
- Changing the preview opened from Sheaf tab hover cards.
