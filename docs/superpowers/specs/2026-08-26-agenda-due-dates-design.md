# Agenda and Due-Date Design

## Goal

Complete `/agenda` as one calendar projection over Clepsydra's two work models:

- a **Todo** is a Markdown checkbox item;
- a **Task** is a page-backed unit of work tracked on the Task Board.

The Agenda must classify due work once, use the viewer's local calendar, preserve each model's existing mutation path, and use the canonical language in `CONTEXT.md`.

## Scope

This feature will:

- include dated Todos and dated Tasks in Agenda;
- replace the Agenda's three fragmented server queries with one classified response;
- use a browser-supplied local date for calendar boundaries;
- remove the existing Overdue/Today duplication;
- rename the Agenda's undated-Todo tab from **Inbox** to **Undated**;
- allow Todo status changes and Task status changes from Agenda;
- retain due-date editing in the existing Folio and Task Board editors;
- update Agenda filters, documentation, generated API types, and tests.

This feature will not:

- show undated Tasks in Agenda;
- add inline due-date editing or drag-to-reschedule behavior;
- rename persisted Task status IDs, API fields, `/tasking`, or Task and Cycle file formats;
- merge Todo A/B/C priorities with Task P0–P3 priorities.

## Canonical language

Human-facing copy uses these terms:

| Domain concept | Display language | Persisted value where applicable |
| --- | --- | --- |
| Markdown checkbox item | Todo | `todo`, `doing`, `done`, `cancelled` |
| Page-backed board item | Task | — |
| Initial Task stage | Inbox | `INTAKE` |
| Assessed Task stage | Ready | `TRIAGE` |
| Active Task stage | In Progress | `FIELD` |
| Review Task stage | Review | `REVIEW` |
| Completed Task stage | Done | `SEALED` |
| Task unable to proceed | Blocked | non-empty `hold` |
| Task without a Cycle | Backlog | absent `cycle` |

Because **Inbox** now means the first Task workflow stage, the Agenda tab for Todos without due dates becomes **Undated**.

## Calendar contract

The browser computes its local date as `YYYY-MM-DD` and sends it with the Agenda request. The server validates both the format and the calendar date. Impossible values such as `2026-02-30` are rejected as client errors.

The server treats the supplied date as `today`. It does not reinterpret it through UTC or a server timezone.

The date windows are inclusive as follows:

- overdue: before `today`;
- today: exactly `today`;
- upcoming: `today + 1` through `today + 7`;
- undated: no `due` property, for open Todos only.

## Classification

Every included item appears in exactly one section. Classification precedence is:

1. Overdue
2. Today
3. Upcoming
4. Undated

An overdue Todo that is also scheduled today remains under Overdue.

| Section | Todos | Tasks |
| --- | --- | --- |
| Overdue | Open with `due < today` | Not Done with `due < today` |
| Today | Open and due today, scheduled today, or contained in today's journal | Not Done and due today |
| Upcoming | Open and due from tomorrow through `today + 7` | Not Done and due from tomorrow through `today + 7` |
| Undated | Open without a due date | Excluded |

For Agenda classification, an open Todo has persisted status `todo` or `doing`. Todos with `done` or `cancelled` status are excluded. Tasks with persisted status `SEALED` are excluded. Blocked Tasks remain visible because Blocked is an orthogonal condition, not a workflow stage.

A scheduled future Todo without a due date remains Undated. `scheduled` affects only the Today classification in this feature.

## Server API

Expose one request:

```http
GET /api/vault/agenda?today=2026-08-26
```

The response is classified on the server:

```ts
type AgendaResponse = {
  overdue: AgendaItem[]
  today: AgendaItem[]
  upcoming: AgendaDay[]
  undated: AgendaTodo[]
}

type AgendaDay = {
  date: string
  items: AgendaItem[]
}

type AgendaItem = AgendaTodo | AgendaTask
```

The discriminated item forms are:

```ts
type AgendaTodo = {
  kind: "todo"
  content: string
  status: "todo" | "doing"
  properties: Record<string, string>
  page_path: string
  page_title: string | null
  span_start: number
  span_end: number
  block_id: string | null
}

type AgendaTask = {
  kind: "task"
  code: string
  title: string
  status: "INTAKE" | "TRIAGE" | "FIELD" | "REVIEW"
  priority: "P0" | "P1" | "P2" | "P3"
  project: string | null
  due: string
  hold: string | null
  path: string
}
```

The exact generated Rust and TypeScript names may follow established schema conventions, but the public discriminator values remain `todo` and `task`.

After all callers migrate, remove `/agenda/today`, `/agenda/week`, and `/agenda/overdue`, their OpenAPI registrations, generated types, query keys, and client hooks. There is no compatibility shim.

## Query and data flow

The server reads indexed Todo blocks and indexed Task page metadata under one index snapshot. It classifies both sources against the validated `today`, sorts them deterministically, and returns one response.

Ordering is:

1. section or upcoming date;
2. due date where applicable;
3. source-specific priority;
4. source page path;
5. Todo span or Task code.

The client owns only presentation and filtering. It does not repeat date classification.

Agenda has one query key parameterized by the browser-local date. Todo mutations, Task mutations, page-body mutations, and index refresh events invalidate that Agenda query.

## UI

The existing tabs remain, with one terminology correction:

- Today
- Upcoming
- Undated

Today contains separate **Overdue** and **Due Today** sections. Upcoming groups items by date.

### Todo rows

A Todo row provides:

- the existing checkbox status control;
- Todo content;
- due and A/B/C priority badges when present;
- a link to the source Folio.

Due-date editing stays in the Folio Todo-properties popover. Any Agenda-adjacent copy that still calls a Todo a Task must use the canonical Todo language.

### Task rows

A Task row provides:

- a status selector displaying Inbox, Ready, In Progress, Review, and Done;
- Task title and TSK code;
- Project, due date, P0–P3 priority, and Blocked indication when present;
- a link to the Task Folio.

The selector writes the persisted IDs `INTAKE`, `TRIAGE`, `FIELD`, `REVIEW`, and `SEALED`. Its labels come from the Task Board's shared status-label mapping. Agenda must not define another mapping.

Due-date editing stays in the Task Board edit panel.

### States

Each surface provides explicit loading, request-error, empty-result, and filtered-empty states. A failed status mutation leaves the current item visible and reports the existing mutation error rather than optimistically classifying it into another section.

## Filters

Todo and Task status and priority are separate domains. Agenda exposes:

| Filter | Values and behavior |
| --- | --- |
| Type | Todo, Task |
| Todo status | Open, Doing |
| Todo priority | High (A), Medium (B), Low (C) |
| Task status | Inbox, Ready, In Progress, Review |
| Task priority | Critical (P0), High (P1), Medium (P2), Low (P3) |
| Project | Valid Projects; applies to Tasks |
| Blocked | Applies to Tasks |
| Text | Todo content, Task title, and source page title/path |

Selecting a type-specific filter selects that type. For example, Task priority High returns only Tasks with persisted priority `P1`. Without a type-specific filter, both types remain eligible.

Filter state remains URL-backed through the existing Agenda filter protocol.

## Documentation

Update `ui/src/docs/content/tasks-agenda-journals-and-board.mdx` to:

- describe Agenda as a projection over Todos and dated Tasks;
- state the browser-local calendar contract;
- document the exact section boundaries and precedence;
- remove the documented duplicate Overdue/Today defect;
- rename the Agenda Inbox section to Undated;
- describe Todo checkbox controls and the Task status selector;
- direct due-date edits to Folio for Todos and the Task Board for Tasks;
- retain the persisted-value reference table.

## Error handling

- Missing or invalid `today` input returns a client error with the accepted format.
- Index or query failures use the existing API error envelope.
- A Todo mutation conflict follows the existing stale-span and protected-page rules.
- A Task status mutation follows existing Task Board validation.
- Client query failures render an error state and do not render stale sections as current results.

## Test contracts

Server tests must prove:

1. valid browser-local dates drive classification without UTC reinterpretation;
2. malformed and impossible dates are rejected;
3. each item is returned at most once;
4. overdue work does not appear under Today;
5. Upcoming starts tomorrow and ends at `today + 7`;
6. scheduled-today Todos appear under Today;
7. today's open journal Todos appear under Today;
8. scheduled future Todos without `due` remain Undated;
9. undated Tasks are excluded;
10. Done Tasks and done or cancelled Todos are excluded;
11. Blocked Tasks remain eligible;
12. response ordering is deterministic.

UI tests must prove:

1. the browser-local date is sent in the query;
2. canonical Todo and Task language is rendered;
3. the tab label is Undated, not Inbox;
4. Task statuses display shared labels while mutations send persisted IDs;
5. Todo and Task rows use their respective controls and links;
6. source-specific filters do not conflate status or priority domains;
7. loading, request-error, empty, and filtered-empty states are distinct;
8. Todo and Task mutations invalidate the consolidated Agenda query.

## Completion criteria

TSK-0077 is complete when the consolidated API, dual-source UI, status mutations, filters, documentation, generated schema, and test contracts ship together; the three obsolete Agenda endpoints and client paths are removed; typecheck, lint, Rust tests, UI tests, and the full project test suite pass; and the Agenda behavior is verified in the running application.