# UI Performance Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task with review gates.

**Goal:** Reduce UI bundle and render-path costs across the seven findings while preserving existing behavior.

**Architecture:** Keep the existing TanStack Router, React, Zustand, and React Query architecture. Isolate documentation constants, split reading-progress subscriptions, make preview drag persistence commit-based, isolate timer updates, and gate infrequent overlays. Use explicit lazy import functions and focused behavioral tests.

**Tech Stack:** React 19, TypeScript, TanStack Router, Zustand, TanStack Query, Vite, Vitest, Testing Library, Bun.

## Global Constraints

- Preserve existing navigation, docs search, preview hover/pin/drag behavior, editor scrolling, and timer displays.
- Follow existing React, TanStack Router, Zustand, and Vitest patterns.
- No broad refactor unrelated to the seven findings.
- Use explicit lazy-import paths; do not introduce dynamic import variables.
- Production entry must fall below Vite's 500 kB warning threshold after bundle changes; if not, split MDX pages explicitly.
- Every production change requires a focused failing test before implementation.

---

### Task 1: Isolate documentation constants and route discovery

**Files:**
- Create: `ui/src/docs/constants.ts`
- Modify: `ui/src/components/codex/CodexFrame.tsx`
- Modify: `ui/src/routes/__tests__/link-miss.test.tsx` (rename with route ignore prefix)
- Test: existing docs registry and route tests

**Interfaces:**
- Produces `DEFAULT_DOC_SLUG: string` from `ui/src/docs/constants.ts`.
- `CodexFrame` imports the constant without importing `ui/src/docs/registry.ts`.

- [ ] **Step 1: Write the failing test**

Add a focused module-boundary test or existing import-level assertion proving the shell constant is available from the dependency-free module and that docs registry behavior remains unchanged.

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run `bun test src/docs/registry.test.ts`; confirm the new import contract fails before the constant exists.

- [ ] **Step 3: Implement the minimal boundary change**

Move the constant, update `CodexFrame`, and rename the route test with the configured `-` prefix. Do not alter docs registry data or route behavior.

- [ ] **Step 4: Verify tests and production bundle**

Run `bun test src/docs/registry.test.ts` and `bun run build`. Confirm the route warning is absent and the entry chunk is below 500 kB. If it is not, add explicit per-page MDX lazy imports and focused route tests before proceeding.

- [ ] **Step 5: Commit**

Commit as `perf(ui): isolate docs shell dependencies`.

---

### Task 2: Split reading-progress subscriptions

**Files:**
- Modify: `ui/src/components/codex/ReadingProgressContext.tsx`
- Modify: `ui/src/components/codex/CodexFrame.tsx`
- Modify: `ui/src/components/codex/Folio.tsx`
- Test: `ui/src/components/codex/__tests__/ReadingProgressContext.test.tsx`

**Interfaces:**
- Preserve `useReadingProgress()` for value consumers.
- Add a setter-only hook with the exact type `(progress: number) => void` for Folio.

- [ ] **Step 1: Write the failing test**

Render a value consumer and setter-only consumer, update progress, and assert the setter-only consumer render count remains unchanged while the value consumer updates.

- [ ] **Step 2: Run the focused test and verify it fails**

Run `bun test src/components/codex/__tests__/ReadingProgressContext.test.tsx`; confirm the setter-only consumer currently re-renders because the context value changes.

- [ ] **Step 3: Implement split contexts and frame-coalesced scroll updates**

Use separate value/actions contexts. Update `CodexFrame` to read progress and `Folio` to read only the setter. Coalesce `onScroll` writes with one pending `requestAnimationFrame`, cancel it on unmount, and flush the latest scroll position.

- [ ] **Step 4: Verify focused and editor tests**

Run the new context test and the existing Folio/editor tests.

- [ ] **Step 5: Commit**

Commit as `perf(ui): isolate reading progress updates`.

---

### Task 3: Make preview dragging commit-based

**Files:**
- Modify: `ui/src/store/preview.ts`
- Modify: `ui/src/components/codex/LinkPreviewLayer.tsx`
- Test: `ui/src/store/preview.test.ts`

**Interfaces:**
- Preserve public preview actions and hover semantics.
- Add only the smallest internal action needed to commit final coordinates once.

- [ ] **Step 1: Write the failing store test**

Exercise a pinned preview drag/update path and assert localStorage is not written for transient movement but is written with final coordinates at completion.

- [ ] **Step 2: Run the focused test and verify it fails**

Run `bun test src/store/preview.test.ts`; confirm current movement writes persistence on every update.

- [ ] **Step 3: Implement transient drag state and final persistence**

Keep pointer movement frame-coalesced. Avoid `savePinned` during transient movement; commit final coordinates on pointer-up. Use narrow Zustand selectors for actions and render preview position with a transform where compatible with existing styles.

- [ ] **Step 4: Verify preview tests**

Run `bun test src/store/preview.test.ts src/components/codex/__tests__/CLink.test.tsx` and confirm hover, pin, close, and drag behavior.

- [ ] **Step 5: Commit**

Commit as `perf(ui): defer preview position persistence`.

---

### Task 4: Isolate timer-driven rendering

**Files:**
- Modify: `ui/src/components/codex/CodexFrame.tsx`
- Modify: `ui/src/hooks/useClock.ts`
- Modify: `ui/src/hooks/useUptime.ts`
- Modify: `ui/src/components/codex/Atrium.tsx`
- Test: existing `useClock` tests plus focused timer/component tests

**Interfaces:**
- Preserve the displayed clock and uptime strings.
- Preserve `useClock(): Date` behavior for existing consumers unless a smaller internal hook is introduced.

- [ ] **Step 1: Write failing cadence/isolation tests**

Test that the shell’s unrelated content does not re-render for clock ticks, uptime formatting changes only at visible cadence, and Atrium day-derived calculations do not rerun for same-day second ticks.

- [ ] **Step 2: Run focused tests and verify failure**

Run the relevant hook/component tests and confirm current timers trigger parent renders and minute-invariant recalculation.

- [ ] **Step 3: Implement timer isolation**

Extract clock text into a small component. Reduce uptime local updates to the smallest cadence visible in the formatted output. Separate Atrium day-derived memo dependencies from high-frequency display state and retain correct day rollover behavior.

- [ ] **Step 4: Verify timer and Atrium tests**

Run focused timer/Atrium tests and existing CodexFrame tests.

- [ ] **Step 5: Commit**

Commit as `perf(ui): isolate timer-driven renders`.

---

### Task 5: Gate and lazy-load global overlays

**Files:**
- Modify: `ui/src/routes/__root.tsx`
- Modify: `ui/src/components/codex/CommandPalette.tsx`
- Test: existing root/CommandPalette/SettingsModal tests

**Interfaces:**
- Preserve modal open/close, focus, dismissal, and keyboard behavior.
- Preserve query result shapes and command actions.

- [ ] **Step 1: Write failing gate tests**

Assert closed command palette does not mount its content or issue tag/search subscriptions, and opening it loads and displays the same commands.

- [ ] **Step 2: Run focused tests and verify failure**

Run the palette/root tests; confirm hidden components and queries currently initialize eagerly.

- [ ] **Step 3: Implement explicit lazy gates**

Use literal `lazy(() => import("..."))` functions and state gates around infrequent overlays. Add query `enabled` conditions for hidden palette state. Keep always-needed shell behavior unchanged.

- [ ] **Step 4: Verify overlay behavior and build**

Run all affected component tests and `bun run build`; inspect that overlay modules are split and the common entry remains below the threshold.

- [ ] **Step 5: Commit**

Commit as `perf(ui): gate infrequent overlays`.

---

### Task 6: Simplify command-palette selection reset

**Files:**
- Modify: `ui/src/components/codex/CommandPalette.tsx`
- Test: `ui/src/components/codex/__tests__/CommandPalette.test.tsx`

- [ ] **Step 1: Write the failing interaction test**

Type a new query after moving selection and assert selection resets synchronously with the input update.

- [ ] **Step 2: Run the focused test and verify failure**

Run the CommandPalette test and observe the effect-based reset timing.

- [ ] **Step 3: Move reset into the input handler**

Set the query and selection together in `onChange`; remove the query-dependent reset effect.

- [ ] **Step 4: Run CommandPalette tests**

Run the focused test file and existing palette tests.

- [ ] **Step 5: Commit**

Commit as `perf(ui): reset palette selection with input`.

---

### Task 7: Final review and verification

**Files:**
- Modify only files required by review findings.
- Test: full UI suite and production build.

- [ ] **Step 1: Run full verification gates**

From `ui/`, run `bun run typecheck`, `bun run lint`, `bun run test`, and `bun run build`.

- [ ] **Step 2: Review bundle output and behavior**

Record entry/chunk sizes, confirm no route warning, and exercise docs navigation, palette open/search, preview drag/pin, editor scroll, and timer displays.

- [ ] **Step 3: Run final code review**

Review the complete branch diff for scope, regressions, accessibility, and adherence to the seven findings. Fix load-bearing findings before completion.

- [ ] **Step 4: Commit final corrections**

Use a focused commit message describing any review-driven correction.
