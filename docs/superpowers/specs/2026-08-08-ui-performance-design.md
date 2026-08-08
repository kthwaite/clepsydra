# UI Performance and Rendering Optimization

## Goal

Apply the seven findings from the UI best-practice scan without changing user-visible behavior. Work is isolated on branch `perf/ui-performance-scan`.

## Scope

1. Remove the eager documentation registry dependency from the application shell. Move `DEFAULT_DOC_SLUG` to a dependency-free module, then measure the production bundle. Add per-page MDX splitting only if the entry remains at or above Vite's 500 kB warning threshold after the first change.
2. Split reading-progress value and actions so Folio does not subscribe to progress updates. Coalesce scroll updates with `requestAnimationFrame`.
3. Make link-preview dragging transient and avoid synchronous `localStorage` writes per animation frame. Persist pinned coordinates at drag completion and narrow Zustand subscriptions.
4. Isolate per-second clock rendering from `CodexFrame`, reduce uptime updates to the visible cadence, and avoid recalculating Atrium day/sky data on every second tick.
5. Lazy-load infrequently used root overlays and gate command-palette queries/mounting by open state while preserving intentional modal behavior.
6. Reset command-palette selection in the input handler instead of a query-dependent effect.
7. Exclude route tests from TanStack Router route discovery so production builds emit no route warning.

## Constraints

- Preserve existing navigation, docs search, preview hover/pin/drag behavior, editor scrolling, and timer displays.
- Follow existing React, TanStack Router, Zustand, and Vitest patterns.
- No broad refactor unrelated to the seven findings.
- Use explicit lazy-import paths; do not introduce dynamic import variables.

## Design

### Bundle boundaries

`DEFAULT_DOC_SLUG` becomes a small standalone export. The root frame imports only that constant. The docs registry remains responsible for docs metadata, compiled components, and raw source. Bundle output is inspected after the change; further MDX splitting is conditional on measured output rather than assumed.

### Reading progress

The provider exposes progress and a stable setter through separate contexts. `CodexFrame` reads progress for its footer. `Folio` receives only the action context and updates it through a frame-coalesced scroll handler. The provider's public hooks remain project-local and type-safe.

### Preview drag lifecycle

A drag starts with the current window coordinates and updates the rendered window position without serializing pinned state on every pointer frame. Pointer movement remains frame-coalesced. Pointer-up commits the final position and performs the persistence write once. Existing hover-close and pin/minimize semantics remain unchanged.

### Timer cadence

Clock text is extracted into a small component so parent shell content does not re-render every second. Uptime polling remains server-backed; local extrapolation updates at the smallest cadence visible in the formatted output. Atrium calculations use stable day-level dependencies for day-derived values and a deliberately bounded clock cadence for sky display.

### Conditional overlays and queries

Root overlays use explicit lazy imports and are mounted behind their corresponding UI-state gates. Command palette search remains debounced and uses `enabled` conditions for hidden state. Existing modal focus and dismissal behavior is retained.

## Testing and verification

Add or update focused tests for:

- the standalone docs constant and route behavior;
- progress updates not re-rendering the Folio subscriber;
- preview drag persistence occurring at completion rather than per frame;
- gated palette queries and overlay mounting;
- clock/uptime observable cadence;
- route generation warning removal where practical.

Run from `ui/` before completion:

- `bun run typecheck`
- `bun run lint`
- `bun run test`
- `bun run build`

Record bundle sizes and test counts in the final report.
