# Task 5 Report: Unified Agenda Screen and Filters

## Status

Complete. The Agenda route now uses one browser-local-date `useAgenda` query. It renders classified Today, Upcoming, and Undated panels from the consolidated response. It provides deterministic URL-backed filters for both Todo and Task items. The temporary Task 3–4 UI typecheck debt is retired.

## TDD evidence

### RED: unified route

Command from `ui/`:

```text
bun run test src/routes/-agenda.test.tsx
```

Observed before the route implementation: 1 file failed, 21 tests failed. The failures were the intended missing behavior: the URL codec still exposed only `status` and `priority`; the route mock reported missing `useAgendaToday`; and every new unified-screen assertion failed because the route still used the old hooks and panels.

### GREEN: unified route

Command from `ui/`:

```text
bun run test src/routes/-agenda.test.tsx
```

Observed after implementation: 1 file passed, 21 tests passed.

### RED: visible Todo-properties copy

Command from `ui/`:

```text
bun run test src/editor/__tests__/SlateEditor.task-properties.test.tsx src/editor/schema/elements/list.taskProperties.test.tsx src/lib/shortcuts.test.ts
```

Observed after changing the expectations and before changing production copy: 3 files failed, 12 tests failed. Failures showed the old `Task properties` dialog/control/shortcut labels.

### GREEN: focused acceptance suite

Command from `ui/`:

```text
bun run test src/routes/-agenda.test.tsx src/components/agenda/AgendaItemList.test.tsx src/components/codex/AgendaTile.test.tsx src/editor/__tests__/SlateEditor.task-properties.test.tsx src/editor/schema/elements/list.taskProperties.test.tsx src/lib/shortcuts.test.ts
```

Observed: 6 files passed, 75 tests passed.

The AgendaTile test was included because the clean TaskList deletion required migrating its `priorityLabel` import. The parent agent explicitly approved modifying `AgendaTile.tsx` and `AgendaTile.test.tsx` for that caller migration.

## Typecheck

Command from `ui/`:

```text
bun run typecheck
```

Observed: `tsc --noEmit --project tsconfig.app.json` exited 0 with no diagnostics.

## Retired paths

A focused source search for `useAgendaToday`, `useAgendaWeek`, `useAgendaOverdue`, `#/components/TaskList`, `<TaskList`, and `function TaskList` returned no matches. `ui/src/components/TaskList.tsx` no longer exists. The Agenda route contains one `useAgenda(today)` call, with `today` produced by `localDateKey(new Date())`.

## Files

- Rewritten: `ui/src/routes/agenda.tsx`
- Rewritten: `ui/src/routes/-agenda.test.tsx`
- Deleted: `ui/src/components/TaskList.tsx`
- Modified: `ui/src/components/agenda/AgendaItemList.tsx`
- Modified by approved clean-caller ruling: `ui/src/components/codex/AgendaTile.tsx`
- Modified by approved clean-caller ruling: `ui/src/components/codex/AgendaTile.test.tsx`
- Modified: `ui/src/editor/TaskPropertyPopover.tsx`
- Modified: `ui/src/editor/schema/elements/list.tsx`
- Modified: `ui/src/editor/__tests__/SlateEditor.task-properties.test.tsx`
- Modified: `ui/src/editor/schema/elements/list.taskProperties.test.tsx`
- Modified: `ui/src/lib/shortcuts.ts`
- Modified: `ui/src/lib/shortcuts.test.ts`
- Added: `.superpowers/sdd/2026-08-26-agenda-due-dates/task-5-report.md`

## Self-review

- The route computes one local calendar key and passes one query state into the screen. No panel owns a request.
- Today uses the response's separate `overdue` and `today` arrays, so rows are not merged or duplicated.
- Upcoming maps `day.items` and parses each date as a local calendar date before formatting.
- Undated explicitly retains only generated `kind: "todo"` items.
- Loading, request error, source-empty, and filtered-empty states are distinct. Request errors never fall through to empty copy.
- `matchesAgendaFilter` is pure. Text, type, Todo facets, Task facets, Project, and Blocked use only their documented source fields. A source-specific facet rejects the opposite item variant before field matching.
- Todo persisted status `todo` maps to URL/display filter value `open`; `doing` remains separate. Task status labels continue to come from the shared Tasking constants.
- Project options are derived from the consolidated response and sorted. Filtered arrays are memoized derivations, not copied state.
- The visible copy says `Todo properties`. Internal component, file, shortcut command, and test-suite identifiers remain unchanged.
- `priorityLabel` moved to the Agenda row module. AgendaTile now imports that single source. No compatibility module remains.

## Commit

Commit message: `feat(agenda): complete dual-source Agenda screen` (the Task 5 commit containing this report).

## Concerns

No implementation concerns. Focused Vitest runs emitted the repository's existing Vite native-config warning about `__dirname` and an extensionless import. It did not affect the test result. Per assignment, lint, formatting, build, and full suites were not run.
