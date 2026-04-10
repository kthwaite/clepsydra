# Decision: Defer Workspace TabBar RAC Migration

**Date:** 2026-04-10
**Status:** Accepted

## Context

The workspace TabBar (`ui/src/components/TabBar.tsx`) has interaction complexity beyond what RAC Tabs supports natively:

- Native HTML5 drag-and-drop for tab reordering
- Hand-rolled context menu (right-click, fixed positioning)
- Middle-click close (`onMouseDown` with `e.button === 1`)
- Close button nested inside tab button (requires `stopPropagation`)
- Disconnected `TabContent` component (Zustand store bridges TabBar and content)

RAC Tabs expects `TabPanel` as a sibling of `TabList` inside a `Tabs` wrapper. The current architecture — where `TabBar` and `TabContent` are separate components connected via Zustand — fundamentally mismatches this model.

## Decision

Defer TabBar migration. The existing `ui/src/components/ui/tabs.tsx` RAC wrapper serves simple tab use cases (agenda page). The workspace TabBar should be treated as a separate design task when workspace tab accessibility becomes a priority.

## Incremental improvements (no full migration needed)

- Add `role="tablist"` to the tab strip container
- Add `role="tab"` and `aria-selected` to individual tabs
- Add roving tabindex for arrow-key navigation between tabs
- Add `aria-controls` pointing to the content panel

These can be added to the current implementation without switching to RAC.
