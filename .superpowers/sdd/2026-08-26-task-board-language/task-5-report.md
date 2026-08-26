# Task 5 Report: Task Board Documentation

## Status

Complete.

## Documentation test convention

The existing `ui/src/routes/__tests__/-docs.test.ts` suite covers documentation routing, lazy page boundaries, navigation, and recovery. It has no rendered-copy assertions for either changed guide. No directly matching rendered-documentation test exists, so no test was modified and no source-text test framework was created.

## Verification

Focused documentation test:

`bun run test -- src/routes/__tests__/-docs.test.ts`

Result: 1 test file passed; 28 tests passed. Vitest also emitted the existing Vite native-config compatibility warning and jsdom `scrollTo` notices.

Copy audit:

Searched both changed guides for `Tasking`, `NEW TASKING`, `disposition`, `optional brief`, the former uppercase view labels, `On Hold`, `IN-FIELD`, and `OPS REGISTER`.

Result: no matches.

Patch hygiene:

`git diff --check`

Result: passed with no output.

## Files

- `ui/src/docs/content/tasks-agenda-journals-and-board.mdx`
- `ui/src/docs/content/getting-started.mdx`
- `.superpowers/sdd/2026-08-26-task-board-language/task-5-report.md`

`CONTEXT.md` was reviewed and left unchanged. Its existing definitions already match the implemented Task, Todo, Checklist Item, Project, Cycle, Backlog, Blocked, status, priority, and related-page language.

## Decisions

- Defined a Task as page-backed Task Board work, a Todo as any Markdown checkbox regardless of status, and a Checklist Item as a Todo inside a Task.
- Documented the Board, List, Cycles, and Timeline views and the Project, Cycle, and Backlog scopes.
- Documented Inbox, Ready, In Progress, Review, Done, Critical, High, Medium, Low, and Blocked as user-facing labels.
- Documented Create cycle, Start cycle, Close cycle, and the three close carryover choices.
- Kept persisted status, priority, Cycle state, `BACKLOG`, `hold`, and `carry_to` values in a dedicated Markdown/API contract section only.
- Replaced Tasking and register-era language only in Task Board documentation. Agenda, Atrium, editor, API, persistence, and unrelated use of “operation” remain unchanged.
- Formatter, lint, typecheck, full suite, and project-wide validation were intentionally not run, per the task constraints.

## Commit

`docs(tasking): document neutral board language` (this task commit)
