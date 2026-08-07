# Atrium Activity Popover Design

## Goal

Make each day square in the Atrium activity heatmap explainable and actionable. Hovering a square shows its UTC date, the number of captures represented by that square, and up to five matching pages. Selecting a page opens it in the workspace.

## Decisions

- **Preserve current activity semantics.** A page belongs to the UTC day of `updated_at`, falling back to `created_at` when no update timestamp exists. Counts, levels, totals, and streaks retain their existing meaning even though the UI calls the entries “captures.”
- **One controlled popover.** The heatmap owns one active day and renders one React Aria popover anchored to the active square. It does not render a popover instance for every day.
- **Interactive, not tooltip semantics.** Day squares are buttons. Hover, keyboard focus, and touch/click can open the popover; the popover remains open while the pointer moves from the square into its page list.
- **Five-page limit.** The popover lists at most five matching pages, newest activity first. When more exist, it shows `+N more`; the headline count always reports the full number.
- **Existing navigation path.** Page rows call `openTab("page", path, title)` through `useOpenTab`, which opens or focuses the page tab and navigates to `/workspace`.
- **UTC remains explicit.** Dates are grouped and presented as UTC because the heatmap caption and current derivation are UTC-based.

## Behavior Contract

- Every non-future heatmap day is a focusable square button with an accessible label containing its formatted UTC date and capture count. Future placeholders in the final partial week remain inert spans.
- Hovering or focusing a day opens a compact popover anchored to that square.
- Touching or clicking a day also opens the popover, so the page list is available without hover.
- Moving the pointer from the square into the popover does not close it. Leaving both closes it after a short bridge delay. Escape and outside interaction dismiss it.
- The popover header shows the full UTC date and `N capture`/`N captures`.
- A non-empty day lists up to five page titles. A missing title falls back to its path.
- Page rows are buttons. Activating one opens that page in the workspace using the existing tab deduplication behavior.
- If a day contains more than five pages, the list ends with a non-interactive `+N more` summary.
- An empty day still opens a popover showing its date and `0 captures`, with no page list.
- Existing square colors, month/day labels, totals, longest streak, and current streak remain unchanged.

## Data Model

`buildHeatmap` replaces each numeric day level with a structured day value:

```ts
interface HeatmapDay {
  date: string; // YYYY-MM-DD UTC
  isFuture: boolean;
  count: number;
  level: number; // 0..5
  pages: HeatmapPage[]; // all matching pages, newest activity first
}

interface HeatmapPage {
  path: string;
  title?: string | null;
  activityAt: string;
}
```

`HeatItem` gains the optional `path` and `title` fields already supplied by the content-index response. During one pass over items, `buildHeatmap` groups pages by the same selected timestamp it currently counts (`updated_at ?? created_at`). Each emitted day reads its count and ordered pages from that group. Streak calculations use `day.count > 0`; totals retain the current one-page/one-day-entry calculation.

The derivation retains all matching pages so the display limit remains a presentation decision and the full count cannot diverge from the popover summary.

## Component Design

`Atrium` continues deriving the heatmap with `buildHeatmap(items, now)` and passes structured weeks to `Heatmap`. It also passes a page-open callback backed by its existing `useOpenTab` hook.

`Heatmap` owns:

- the active `HeatmapDay`;
- the active square element used as the popover trigger reference;
- a short close timer shared by square and popover pointer handlers;
- handlers for hover, focus, touch/click, dismissal, and page activation.

The popover uses the existing Atrium visual language: paper background, rule border, compact monospace metadata, and understated page rows. The square’s color still comes solely from `HEAT_LEVEL[day.level]`.

## Accessibility

- Non-future squares use native button semantics instead of non-interactive spans.
- Each non-future square receives an `aria-label` with date and count; the color level is not the only information available.
- Keyboard focus opens the same content as pointer hover.
- The interactive page list lives in a popover/dialog surface rather than a tooltip, because tooltips must not contain controls.
- Escape and outside press close the surface through React Aria dismissal behavior.
- Focus styling must remain visible against every heat level.

## Error and Edge Handling

- Items without either timestamp remain excluded, matching current behavior.
- Items without a path contribute to counts and streaks but do not produce clickable page rows.
- Invalid or incomplete titles fall back to the page path.
- Future cells in the final partial week are marked `isFuture`, remain level zero, render as inert spans, and do not open popovers.
- Duplicate paths are not collapsed: the content index is the source of truth, and preserving one count per returned item keeps totals consistent with current behavior.

## Verification

### Derivation tests

Extend `atrium-data.test.ts` to prove:

- emitted day values contain the correct UTC date, count, level, and matching pages;
- `updated_at` takes precedence over `created_at`;
- pages are ordered by activity timestamp descending;
- pathless items affect counts but are omitted from page rows;
- totals and streaks retain their existing results.

### Interaction tests

Add focused component coverage proving:

- hover and keyboard focus show the correct date and pluralized count;
- at most five pages render and overflow is summarized;
- moving into the popover keeps it available;
- activating a page calls the supplied open-page callback with path and display title;
- an empty day shows `0 captures` and no page controls.

### End-to-end check

Run the Atrium, hover an active square, move into its popover, select a page, and confirm the workspace opens or focuses that page tab. Also verify an empty square and keyboard focus behavior.

## Out of Scope

- Changing the heatmap from latest activity to creation-only captures.
- Splitting created and edited activity.
- Adding pagination or search inside the popover.
- Opening a day-level filtered Gazetteer view.
- Changing the content-index endpoint or its 500-item request limit.
