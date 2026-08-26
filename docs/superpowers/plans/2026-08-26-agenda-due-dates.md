# Agenda and Due-Date Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete `/agenda` as a browser-local, non-duplicating projection over dated Tasks and open Todos, with Undated Todos, source-specific controls, filters, and documentation.

**Architecture:** Replace the three Agenda endpoints with one `GET /agenda?today=YYYY-MM-DD` handler that reads and classifies Todo blocks and Task pages in one index callback. Generate the OpenAPI contract, expose one React Query hook, and split Agenda presentation into a route-owned filter shell plus source-specific row components. Existing Todo and Task mutation endpoints remain authoritative.

**Tech Stack:** Rust 2024, Axum, rusqlite, chrono, serde, utoipa/OpenAPI, React 19, TypeScript 5.9, TanStack Router and Query, React Aria Components, Vitest, Testing Library, Biome.

**Spec:** `docs/superpowers/specs/2026-08-26-agenda-due-dates-design.md`

## Global Constraints

- Human-facing copy uses `Task`, `Todo`, `Checklist Item`, `Project`, `Cycle`, `Backlog`, `Blocked`, `Inbox`, `Ready`, `In Progress`, `Review`, and `Done` as defined in `CONTEXT.md`.
- Persisted Task statuses remain `INTAKE`, `TRIAGE`, `FIELD`, `REVIEW`, and `SEALED`.
- Todo priorities A/B/C and Task priorities P0/P1/P2/P3 remain separate domains.
- The browser supplies `today`; the server validates it and does not reinterpret it through UTC.
- Agenda sections have fixed precedence: Overdue, Today, Upcoming, Undated.
- Undated Tasks never appear in Agenda.
- Due-date edits remain in Folio for Todos and the Task Board for Tasks.
- Remove obsolete Agenda endpoints and client paths after migrating every caller; add no compatibility shim.
- Follow TDD: observe each focused test fail before implementation, then pass before commit.

---

### Task 1: Consolidated Todo Agenda Contract

**Files:**
- Modify: `src/api/agenda.rs:1-630`
- Modify: `src/api/openapi.rs:172-180,389-397`
- Rewrite Agenda endpoint cases: `tests/api_agenda_test.rs:259-559`
- Test: `tests/openapi_contract.rs`

**Interfaces:**
- Consumes: indexed Todo blocks and `block_properties`; `TaskItem` field mapping from `src/api/tasks.rs`.
- Produces: `AgendaQuery { today: String }`, validated `NaiveDate`, `AgendaResponse`, `AgendaDay`, `AgendaItem`, and `GET /api/vault/agenda?today=YYYY-MM-DD`.
- Later tasks rely on JSON keys `overdue`, `today`, `upcoming`, `undated`; `AgendaItem.kind === "todo" | "task"`; and `AgendaDay.items`.

- [ ] **Step 1: Replace clock-derived integration fixtures with fixed-date failing tests**

Rewrite the Agenda portion of `tests/api_agenda_test.rs` around a fixed boundary:

```rust
const TODAY: &str = "2026-08-26";

async fn get_agenda(server: &TestServer) -> serde_json::Value {
    let response = server.get(&format!("/api/vault/agenda?today={TODAY}")).await;
    response.assert_status_ok();
    response.json()
}

#[tokio::test]
async fn agenda_rejects_missing_malformed_and_impossible_today() {
    let (server, _tmp) = setup_server();
    server.get("/api/vault/agenda").await.assert_status_bad_request();
    server
        .get("/api/vault/agenda?today=26-08-2026")
        .await
        .assert_status_bad_request();
    server
        .get("/api/vault/agenda?today=2026-02-30")
        .await
        .assert_status_bad_request();
}

#[tokio::test]
async fn agenda_classifies_each_open_todo_once() {
    let (server, _tmp) = setup_server();
    server
        .post("/api/vault/pages/agenda-fixture.md")
        .json(&serde_json::json!({
            "title": "Agenda fixture",
            "body": "- [ ] overdue scheduled today [due:: 2026-08-25] [scheduled:: 2026-08-26]\n\
                     - [ ] due today [due:: 2026-08-26]\n\
                     - [ ] due tomorrow [due:: 2026-08-27]\n\
                     - [ ] due at boundary [due:: 2026-09-02]\n\
                     - [ ] beyond boundary [due:: 2026-09-03]\n\
                     - [ ] undated [scheduled:: 2026-09-01]\n\
                     - [x] completed [due:: 2026-08-26]\n\
                     - [-] cancelled [due:: 2026-08-26]\n"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let body = get_agenda(&server).await;
    assert_eq!(body["overdue"].as_array().unwrap().len(), 1);
    assert_eq!(body["today"].as_array().unwrap().len(), 1);
    assert_eq!(body["upcoming"].as_array().unwrap().len(), 2);
    assert_eq!(body["upcoming"][0]["date"], "2026-08-27");
    assert_eq!(body["upcoming"][1]["date"], "2026-09-02");
    assert_eq!(body["undated"].as_array().unwrap().len(), 1);

    let all_content = body["overdue"].as_array().unwrap().iter()
        .chain(body["today"].as_array().unwrap())
        .chain(body["upcoming"].as_array().unwrap().iter().flat_map(|day| day["items"].as_array().unwrap()))
        .chain(body["undated"].as_array().unwrap())
        .map(|item| item["content"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(all_content.iter().filter(|content| content.contains("overdue scheduled today")).count(), 1);
    assert!(!all_content.iter().any(|content| content.contains("beyond boundary")));
    assert!(!all_content.iter().any(|content| content.contains("completed")));
    assert!(!all_content.iter().any(|content| content.contains("cancelled")));
}
```

Retain fixed-date cases for scheduled-today Todos, open Todos from a journal page whose `journal_date` equals `TODAY`, deterministic ordering, and an empty response.

- [ ] **Step 2: Run the focused server tests and verify red**

Run: `cargo test --test api_agenda_test agenda_ -- --nocapture`

Expected: FAIL because `/api/vault/agenda` does not exist and the old response shape is still registered.

- [ ] **Step 3: Define the consolidated schema and strict date parser**

In `src/api/agenda.rs`, replace `AgendaTodayResponse`, `AgendaWeekResponse`, and `AgendaOverdueResponse` with:

```rust
#[derive(Debug, Deserialize, IntoParams)]
pub struct AgendaQuery {
    pub today: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AgendaResponse {
    pub overdue: Vec<AgendaItem>,
    pub today: Vec<AgendaItem>,
    pub upcoming: Vec<AgendaDay>,
    pub undated: Vec<AgendaItem>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AgendaDay {
    pub date: String,
    pub items: Vec<AgendaItem>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgendaItem {
    Todo {
        block_id: Option<String>,
        content: String,
        status: String,
        properties: HashMap<String, String>,
        page_path: String,
        page_title: Option<String>,
        span_start: i64,
        span_end: i64,
    },
    Task {
        id: uuid::Uuid,
        code: String,
        title: String,
        status: String,
        priority: String,
        project: Option<String>,
        due: String,
        hold: Option<String>,
        path: String,
    },
}

fn parse_today(value: &str) -> Result<NaiveDate, ApiError> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| ApiError::bad_request("today must be a real date in YYYY-MM-DD format"))
}
```

Import `Query`, `Deserialize`, `IntoParams`, and `NaiveDate`. Make the router expose only `.route("/", get(get_agenda))` plus the existing cycle-burndown route.

- [ ] **Step 4: Implement one Todo query and one classification pass**

Implement:

```rust
pub async fn get_agenda(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AgendaQuery>,
) -> Result<Json<AgendaResponse>, ApiError>
```

Compute `tomorrow` and `end = today + Duration::days(7)`. Inside one `with_index` callback, query open Todo blocks once. Include rows when at least one condition holds:

```sql
status_prop.value IN ('todo', 'doing')
AND (
  bp_due.value < :tomorrow
  OR (bp_due.value >= :tomorrow AND bp_due.value <= :end)
  OR bp_sched.value = :today
  OR p.journal_date = :today
  OR bp_due.value IS NULL
)
```

Load each Todo's properties with the existing `fill_properties` helper. Classify in Rust with this exact precedence:

```rust
if due.is_some_and(|due| due < today_key) {
    overdue.push(todo);
} else if due == Some(today_key)
    || scheduled == Some(today_key)
    || journal_date == Some(today_key)
{
    today_items.push(todo);
} else if due.is_some_and(|due| due >= tomorrow_key && due <= end_key) {
    upcoming_by_date.entry(due.to_string()).or_default().push(todo);
} else if due.is_none() {
    undated.push(todo);
}
```

Carry `journal_date` only as a classification input; do not serialize it into `AgendaItem::Todo`. Sort by the contract before forming `AgendaDay` values.

- [ ] **Step 5: Register the new OpenAPI path and schemas**

In `src/api/openapi.rs`, replace the three old handler registrations and response schemas with `get_agenda`, `AgendaQuery`, `AgendaResponse`, `AgendaDay`, and `AgendaItem`. Add or update the OpenAPI contract assertion in `tests/openapi_contract.rs` so `/api/vault/agenda` exists with required query parameter `today`, while `/agenda/today`, `/agenda/week`, and `/agenda/overdue` do not.

- [ ] **Step 6: Run focused tests and verify green**

Run:

```bash
cargo test --test api_agenda_test agenda_ -- --nocapture
cargo test --test openapi_contract
```

Expected: both commands exit 0; classification and obsolete-path assertions pass.

- [ ] **Step 7: Commit**

```bash
git add src/api/agenda.rs src/api/openapi.rs tests/api_agenda_test.rs tests/openapi_contract.rs
git commit -m "feat(agenda): consolidate Todo date classification"
```

---

### Task 2: Dated Tasks in Agenda

**Files:**
- Modify: `src/api/agenda.rs`
- Modify: `tests/api_agenda_test.rs`

**Interfaces:**
- Consumes: `AgendaItem::Task` and the validated date boundary from Task 1; indexed TASK page columns `id`, `path`, `title`, `meta_json`, and `project`.
- Produces: dated, non-Done Tasks classified into `overdue`, `today`, and `upcoming`; deterministic mixed-source ordering.

- [ ] **Step 1: Add failing Task classification tests**

Seed real Task pages before index construction so the test controls metadata exactly:

```rust
#[tokio::test]
async fn agenda_includes_only_dated_not_done_tasks() {
    let (server, _tmp) = setup_server_with_seed(|root| {
        std::fs::create_dir_all(root.join("tasks/clepsydra")).unwrap();
        std::fs::write(
            root.join("tasks/clepsydra/TSK-0200.md"),
            "+++\nid = \"01900000-0000-7000-8000-000000000200\"\ntitle = \"Overdue Task\"\ntype = \"TASK\"\nstatus = \"FIELD\"\npriority = \"P1\"\nproject = \"clepsydra\"\ndue = \"2026-08-25\"\nhold = \"Waiting for input\"\n+++\n",
        ).unwrap();
        std::fs::write(
            root.join("tasks/clepsydra/TSK-0201.md"),
            "+++\nid = \"01900000-0000-7000-8000-000000000201\"\ntitle = \"Done Task\"\ntype = \"TASK\"\nstatus = \"SEALED\"\npriority = \"P2\"\nproject = \"clepsydra\"\ndue = \"2026-08-26\"\n+++\n",
        ).unwrap();
        std::fs::write(
            root.join("tasks/clepsydra/TSK-0202.md"),
            "+++\nid = \"01900000-0000-7000-8000-000000000202\"\ntitle = \"Undated Task\"\ntype = \"TASK\"\nstatus = \"TRIAGE\"\npriority = \"P2\"\nproject = \"clepsydra\"\n+++\n",
        ).unwrap();
    });

    let body = get_agenda(&server).await;
    let overdue = body["overdue"].as_array().unwrap();
    assert_eq!(overdue.len(), 1);
    assert_eq!(overdue[0]["kind"], "task");
    assert_eq!(overdue[0]["id"], "01900000-0000-7000-8000-000000000200");
    assert_eq!(overdue[0]["status"], "FIELD");
    assert_eq!(overdue[0]["hold"], "Waiting for input");
    assert!(body["today"].as_array().unwrap().is_empty());
    assert!(body["undated"].as_array().unwrap().is_empty());
}
```

Add one mixed-source test proving a due Todo and due Task both appear and preserve deterministic ordering, and one boundary test proving a Task at `today + 7` appears while `today + 8` does not.

- [ ] **Step 2: Run the focused test and verify red**

Run: `cargo test --test api_agenda_test agenda_includes_only_dated_not_done_tasks -- --nocapture`

Expected: FAIL because the consolidated handler does not yet load TASK pages.

- [ ] **Step 3: Query dated Task pages in the same index callback**

Add a focused Task query to `get_agenda` rather than calling the full Board read model:

```sql
SELECT p.id, p.path, p.title, p.meta_json, p.project
FROM pages p
WHERE p.kind = 'TASK'
ORDER BY p.path
```

For each row, parse `meta_json`, then read `status`, `priority`, `due`, and `hold` with the board metadata helper conventions. Skip absent `due` and status `SEALED`. Parse the UUID; derive `code` from the path stem using the existing board path convention. Construct `AgendaItem::Task`, then feed it through the same Overdue/Today/Upcoming classifier. Do not add Tasks to Undated.

Use a small internal sort-key helper:

```rust
fn agenda_priority_key(item: &AgendaItem) -> &str {
    match item {
        AgendaItem::Todo { properties, .. } => properties
            .get("priority")
            .map(String::as_str)
            .unwrap_or("Z"),
        AgendaItem::Task { priority, .. } => priority.as_str(),
    }
}
```

Sort equal-date mixed items by source priority, path, then Todo span or Task code as specified.

- [ ] **Step 4: Run the complete Agenda integration file**

Run: `cargo test --test api_agenda_test -- --nocapture`

Expected: exit 0; Todo-only, Task-only, mixed-source, date-validation, and cycle-burndown tests all pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/agenda.rs tests/api_agenda_test.rs
git commit -m "feat(agenda): include dated Tasks"
```

---

### Task 3: Generated Schema and Consolidated Client Query

**Files:**
- Modify generated file: `ui/src/api/schema.d.ts`
- Modify: `ui/src/api/tasks.ts:1-60`
- Modify: `ui/src/api/keys.ts:25-31`
- Modify: `ui/src/api/board.test.ts`
- Test: create `ui/src/api/tasks.test.ts`

**Interfaces:**
- Consumes: `GET /api/vault/agenda?today=` and generated `AgendaResponse` from Tasks 1–2.
- Produces: `AgendaResponse`, `AgendaItem`, `AgendaTodo`, `AgendaTask` aliases and `useAgenda(today: string)` with query key `queryKeys.agenda.byDate(today)`.

- [ ] **Step 1: Add failing client tests**

Create `ui/src/api/tasks.test.ts` using the repository's QueryClient wrapper pattern. Assert that rendering `useAgenda("2026-08-26")` calls:

```ts
expect(fetchMock).toHaveBeenCalledWith(
  expect.stringContaining("/api/vault/agenda?today=2026-08-26"),
  expect.anything(),
);
```

Assert the returned fixture preserves `kind: "todo"` and `kind: "task"`. In `ui/src/api/board.test.ts`, retain the existing assertion that a successful `usePatchTask` invalidates `queryKeys.agenda.all`.

- [ ] **Step 2: Run the focused tests and verify red**

Run: `bun run test src/api/tasks.test.ts src/api/board.test.ts` from `ui/`.

Expected: FAIL because `useAgenda` and `queryKeys.agenda.byDate` do not exist.

- [ ] **Step 3: Regenerate the OpenAPI TypeScript contract**

Start the backend with `cargo run -- serve`, wait for `http://127.0.0.1:3000/api/openapi.json`, then run `bun run openapi` from `ui/`. Stop the backend after generation. Confirm generated schema contains `/api/vault/agenda`, `AgendaResponse`, and the Todo/Task discriminator, and no old Agenda paths.

- [ ] **Step 4: Replace old Agenda hooks and keys**

In `ui/src/api/keys.ts`:

```ts
agenda: {
  all: ["agenda"] as const,
  byDate: (today: string) => ["agenda", today] as const,
  cycleBurndown: (cycle: string | null, project?: string, unfiled = false) =>
    ["agenda", "cycle-burndown", cycle, project, unfiled] as const,
},
```

In `ui/src/api/tasks.ts`, export generated aliases and one hook:

```ts
export type AgendaResponse = components["schemas"]["AgendaResponse"];
export type AgendaItem = components["schemas"]["AgendaItem"];

export function useAgenda(today: string) {
  return useQuery<AgendaResponse>({
    queryKey: queryKeys.agenda.byDate(today),
    queryFn: async () => {
      const { data, error } = await fetchClient.GET("/api/vault/agenda", {
        params: { query: { today } },
      });
      if (error) throw apiError(error, "Failed to fetch Agenda");
      if (!data) throw new Error("Agenda response was empty");
      return data;
    },
  });
}
```

Delete `useAgendaToday`, `useAgendaWeek`, and `useAgendaOverdue` and their response aliases.

- [ ] **Step 5: Run focused API tests and typecheck**

Run from `ui/`:

```bash
bun run test src/api/tasks.test.ts src/api/board.test.ts
bun run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add ui/src/api/schema.d.ts ui/src/api/tasks.ts ui/src/api/tasks.test.ts ui/src/api/keys.ts ui/src/api/board.test.ts
git commit -m "feat(agenda): add consolidated client query"
```

---

### Task 4: Source-Specific Agenda Rows

**Files:**
- Create: `ui/src/components/agenda/AgendaItemList.tsx`
- Create: `ui/src/components/agenda/AgendaItemList.test.tsx`
- Modify: `ui/src/components/tasking/board-constants.tsx:48-54,101-103`
- Modify: `ui/src/components/tasking/__tests__/board-constants.test.tsx`
- Modify: `ui/src/components/ui/task-status-button.tsx:43-48`
- Modify: `ui/src/components/ui/__tests__/task-status-button.test.tsx`
- Delete after caller migration in Task 5: `ui/src/components/TaskList.tsx`

**Interfaces:**
- Consumes: generated `AgendaItem`, `useToggleTaskStatus`, `usePatchTask`, `useOpenTab`, `COL_LABEL`, `PRI_LABEL`, and existing UI primitives.
- Produces: `AgendaItemList({ items, emptyMessage })`, Todo checkbox rows, and Task status selectors.

- [ ] **Step 1: Export the shared Task status-label resolver under test**

Add this failing assertion to `board-constants.test.tsx`:

```ts
expect(taskStatusLabel("INTAKE")).toBe("Inbox");
expect(taskStatusLabel("FIELD")).toBe("In Progress");
expect(taskStatusLabel("UNKNOWN")).toBe("UNKNOWN");
```

Then export from `board-constants.tsx`:

```ts
export function taskStatusLabel(status: string): string {
  return COL_LABEL[status] ?? status;
}
```

Update `TaskingScreen` only if necessary to consume this resolver instead of an equivalent inline closure.

- [ ] **Step 2: Add failing Todo and Task row interaction tests**

In `AgendaItemList.test.tsx`, mock `useToggleTaskStatus`, `usePatchTask`, and `useOpenTab`. Cover:

```ts
it("toggles a Todo through the Todo mutation", async () => {
  render(<AgendaItemList items={[todoFixture]} />);
  await userEvent.click(screen.getByRole("button", { name: /mark Todo done/i }));
  expect(toggleTodo).toHaveBeenCalledWith({
    pagePath: "notes/source.md",
    spanStart: 12,
    status: "done",
  });
});

it("patches a Task with persisted status ids while showing canonical labels", async () => {
  render(<AgendaItemList items={[taskFixture]} />);
  expect(screen.getByText("In Progress")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /status/i }));
  await userEvent.click(screen.getByRole("option", { name: "Done" }));
  expect(patchTask).toHaveBeenCalledWith({
    id: "01900000-0000-7000-8000-000000000200",
    patch: { status: "SEALED" },
  });
});
```

Also assert Todo badges use A/B/C labels, Task badges use P0–P3 plus `PRI_LABEL`, Blocked renders only for non-empty `hold`, and both row kinds open their source Folio.

- [ ] **Step 3: Run component tests and verify red**

Run: `bun run test src/components/agenda/AgendaItemList.test.tsx src/components/tasking/__tests__/board-constants.test.tsx` from `ui/`.

Expected: FAIL because the component and shared resolver do not exist.

- [ ] **Step 4: Implement the discriminated row component**

Implement one list that narrows on `item.kind`:

```tsx
export function AgendaItemList({
  items,
  emptyMessage = "No items.",
}: {
  items: AgendaItem[];
  emptyMessage?: string;
}) {
  if (items.length === 0) return <EmptyMessage>{emptyMessage}</EmptyMessage>;
  return (
    <ul className="divide-y divide-border border-y border-border">
      {items.map((item) =>
        item.kind === "todo" ? (
          <AgendaTodoRow key={`${item.page_path}:${item.span_start}`} todo={item} />
        ) : (
          <AgendaTaskRow key={item.id} task={item} />
        ),
      )}
    </ul>
  );
}
```

Use the existing `TaskStatusButton` for Todos and change its accessible label from `Mark task ${next}` to `Mark Todo ${next}` with a focused regression in `task-status-button.test.tsx`. Use the shared React Aria `Select` for Tasks with options from `COL_ORDER`, labels from `taskStatusLabel`, and `usePatchTask().mutate({ id, patch: { status } })`. Disable only the control whose mutation is pending. Link rows to `page_path` for Todos and `path` for Tasks through `useOpenTab("page", path)`.

- [ ] **Step 5: Run focused tests and typecheck**

Run from `ui/`:

```bash
bun run test src/components/agenda/AgendaItemList.test.tsx src/components/tasking/__tests__/board-constants.test.tsx src/components/ui/__tests__/task-status-button.test.tsx
bun run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/agenda/AgendaItemList.tsx ui/src/components/agenda/AgendaItemList.test.tsx ui/src/components/tasking/board-constants.tsx ui/src/components/tasking/__tests__/board-constants.test.tsx ui/src/components/tasking/TaskingScreen.tsx ui/src/components/ui/task-status-button.tsx ui/src/components/ui/__tests__/task-status-button.test.tsx
git commit -m "feat(agenda): render Todo and Task rows"
```

---

### Task 5: Unified Agenda Screen and Filters

**Files:**
- Rewrite: `ui/src/routes/agenda.tsx`
- Rewrite: `ui/src/routes/-agenda.test.tsx`
- Delete: `ui/src/components/TaskList.tsx`
- Modify: `ui/src/editor/TaskPropertyPopover.tsx:319-321`
- Modify: `ui/src/editor/schema/elements/list.tsx:132-134`
- Modify: `ui/src/editor/__tests__/SlateEditor.task-properties.test.tsx`
- Modify: `ui/src/editor/schema/elements/list.taskProperties.test.tsx`
- Modify: `ui/src/lib/shortcuts.ts:172-179`
- Modify: `ui/src/lib/shortcuts.test.ts`

**Interfaces:**
- Consumes: `useAgenda(localDateKey(new Date()))`, `AgendaItemList`, `AgendaResponse`, URL filter helpers, and source-specific item fields.
- Produces: Today, Upcoming, and Undated tabs; explicit request-error and filtered-empty states; URL-backed `type`, `todoStatus`, `todoPriority`, `taskStatus`, `taskPriority`, `project`, `blocked`, and text filters.

- [ ] **Step 1: Rewrite route codec tests for the new filter domains**

Define exact URL fields:

```ts
export const AGENDA_FILTER_URL: FilterUrlOptions = {
  fields: [
    { id: "type", kind: "single" },
    { id: "todoStatus", kind: "single" },
    { id: "todoPriority", kind: "single", normalize: (v) => v.toUpperCase() },
    { id: "taskStatus", kind: "single", normalize: (v) => v.toUpperCase() },
    { id: "taskPriority", kind: "single", normalize: (v) => v.toUpperCase() },
    { id: "project", kind: "single" },
    { id: "blocked", kind: "flag" },
  ],
};
```

Tests must assert normalization, unknown-query passthrough, and the exact field ID order.

- [ ] **Step 2: Add failing screen behavior tests**

Mock one `useAgenda` result. Add tests proving:

- the hook receives `localDateKey(new Date())` under a fixed fake timer;
- Today renders separate Overdue and Due Today sections without duplicates;
- Upcoming groups `day.items` and formats local dates;
- the third tab is **Undated**, never **Inbox**;
- Undated contains Todos only;
- request errors show `Couldn’t load Agenda.` instead of an empty state;
- Type, Todo status/priority, Task status/priority, Project, Blocked, and text filters select the documented domains;
- selecting a Task-specific filter excludes Todos, while no type-specific filter keeps both eligible;
- filtered-empty copy differs from source-empty copy.

Use fixtures shaped as generated `AgendaItem` values, not the obsolete `TaskItem` helper.

- [ ] **Step 3: Run route tests and verify red**

Run: `bun run test src/routes/-agenda.test.tsx` from `ui/`.

Expected: FAIL because the route still calls four old hooks, renders Inbox, and has one Todo-only filter domain.

- [ ] **Step 4: Implement one query and pure client filter model**

In `AgendaPage`, compute the local key once per render:

```tsx
const today = localDateKey(new Date());
const agenda = useAgenda(today);
```

Pass the query state into `AgendaScreen`; do not let each panel issue a request. Define a pure `matchesAgendaFilter(item, filterState)` that:

- applies text to Todo content/page and Task title/path;
- applies `type` to both variants;
- immediately excludes the opposite variant when a Todo- or Task-specific facet is present;
- maps Todo status `todo` to display filter value `open` and keeps `doing` distinct;
- maps Task status and priority through persisted values;
- applies Project and Blocked to Tasks only.

Render response arrays through `AgendaItemList`. Keep filtered arrays derived with `useMemo`; no copied state.

- [ ] **Step 5: Remove obsolete UI paths and correct adjacent Todo copy**

Delete imports and callsites for `useAgendaToday`, `useAgendaWeek`, `useAgendaOverdue`, `useTasks` in Agenda, and `TaskList`. Delete `ui/src/components/TaskList.tsx` once references are gone. Change the Folio popover, Todo chip control, and shortcut's visible `Task properties` copy to `Todo properties`; update the listed focused tests. Keep internal component, file, and command identifiers unchanged because they are not human-facing contracts.

- [ ] **Step 6: Run focused UI tests and typecheck**

Run from `ui/`:

```bash
bun run test src/routes/-agenda.test.tsx src/components/agenda/AgendaItemList.test.tsx src/editor/__tests__/SlateEditor.task-properties.test.tsx src/editor/schema/elements/list.taskProperties.test.tsx src/lib/shortcuts.test.ts
bun run typecheck
```

Expected: both commands exit 0; no old Agenda hook or `TaskList` reference remains.

- [ ] **Step 7: Commit**

```bash
git add ui/src/routes/agenda.tsx ui/src/routes/-agenda.test.tsx ui/src/components/TaskList.tsx ui/src/editor/TaskPropertyPopover.tsx ui/src/editor/schema/elements/list.tsx ui/src/editor/__tests__/SlateEditor.task-properties.test.tsx ui/src/editor/schema/elements/list.taskProperties.test.tsx ui/src/lib/shortcuts.ts ui/src/lib/shortcuts.test.ts
git commit -m "feat(agenda): complete dual-source Agenda screen"
```

---

### Task 6: Documentation and Contract Cleanup

**Files:**
- Modify: `ui/src/docs/content/tasks-agenda-journals-and-board.mdx:7-84,163-201`
- Modify: `ui/src/docs/content/editor-workflows.mdx:123-172`
- Modify: `ui/src/docs/mdx-smoke.test.tsx`
- Modify: `ui/src/docs/search.test.ts`

**Interfaces:**
- Consumes: shipped behavior from Tasks 1–5 and canonical vocabulary from `CONTEXT.md`.
- Produces: user documentation matching the consolidated API and visible Agenda behavior; zero obsolete Agenda endpoint references.

- [ ] **Step 1: Add failing documentation assertions**

Update documentation tests to assert the rendered guide contains `Todos and dated Tasks`, `browser’s local date`, and `Undated`, and does not describe duplicate Overdue/Today rows or UTC Agenda boundaries.

- [ ] **Step 2: Run documentation tests and verify red**

Run: `bun run test src/docs/mdx-smoke.test.tsx src/docs/search.test.ts` from `ui/`.

Expected: FAIL against the current defect and UTC documentation.

- [ ] **Step 3: Rewrite the Agenda workflow section**

Document these exact facts:

- Agenda shows open Todos plus dated Tasks that are not Done.
- Overdue precedes Today; Upcoming is tomorrow through seven days ahead; Undated contains open Todos without due dates.
- The browser's local date defines boundaries.
- Todo checkbox changes and Task status changes are available in Agenda.
- Todo due dates are edited in Folio; Task due dates are edited on the Task Board.
- Task display labels map to unchanged persisted values.

Remove the old duplicate and UTC warnings. Change the documented Folio control from **Task properties** to **Todo properties** in both affected guides. Keep unrelated journal and Task Board limitations intact.

- [ ] **Step 4: Prove obsolete contracts are absent**

Search the repository for these exact paths and remove every product, test, and documentation reference:

```text
/api/vault/agenda/today
/api/vault/agenda/week
/api/vault/agenda/overdue
```

Search visible Agenda copy for an `Inbox` tab and replace only the undated-Todo meaning; preserve Task status label Inbox.

- [ ] **Step 5: Run documentation and focused contract tests**

Run:

```bash
bun run test src/docs/mdx-smoke.test.tsx src/docs/search.test.ts
cargo test --test openapi_contract
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add ui/src/docs/content/tasks-agenda-journals-and-board.mdx ui/src/docs/content/editor-workflows.mdx ui/src/docs/mdx-smoke.test.tsx ui/src/docs/search.test.ts
git commit -m "docs: document completed Agenda behavior"
```

---

### Task 7: Full Verification and Browser Smoke Test

**Files:**
- Modify only files required to fix failures caused by Tasks 1–6.
- Update Task Board page `TSK-0077` through the vault server after all gates pass.

**Interfaces:**
- Consumes: complete feature branch.
- Produces: formatter-clean, lint-clean, type-safe, fully tested, browser-verified feature ready for review and merge.

- [ ] **Step 1: Run Rust formatting and lint gates**

Run from the repository root:

```bash
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
```

Expected: both commands exit 0.

- [ ] **Step 2: Run UI typecheck and lint**

Run from `ui/`:

```bash
bun run typecheck
bun run lint
```

Expected: both commands exit 0.

- [ ] **Step 3: Run full Rust and UI test suites**

Run:

```bash
cargo test
bun run test
```

Expected: both commands exit 0. Report any failure exactly; do not attribute an unrelated failure to this feature without evidence.

- [ ] **Step 4: Build the UI**

Run: `bun run build` from `ui/`.

Expected: TypeScript build and Vite production build exit 0.

- [ ] **Step 5: Smoke test the actual Agenda surface**

Start `cargo run -- serve` at the repository root and `bun run dev` from `ui/` as supervised processes. Open the Vite URL in a real browser and exercise `/agenda` with a local vault containing:

- one overdue Todo;
- one Todo due today;
- one scheduled-today Todo;
- one upcoming Todo;
- one undated Todo;
- one overdue Task;
- one Task due today;
- one upcoming Task;
- one undated Task;
- one Done Task.

Verify visually and behaviorally:

- no item appears twice;
- tabs read Today, Upcoming, Undated;
- the undated Task is absent;
- the Done Task is absent;
- Todo checkbox mutation persists and removes completed work;
- Task selector shows Inbox, Ready, In Progress, Review, Done and persists the selected ID;
- Todo and Task source links open the correct Folio;
- source-specific filters produce the specified results;
- browser console has no Agenda errors.

- [ ] **Step 6: Request code review and fix accepted findings**

Use the requesting-code-review workflow against the feature branch. Review both spec compliance and code quality. Apply accepted findings one at a time, rerun their focused tests, then repeat Steps 1–4 if code changed.

- [ ] **Step 7: Mark TSK-0077 Done**

Through `vault_task_update`, set TSK-0077 status to persisted `SEALED` only after all gates and browser verification pass. Update its checklist body through the vault tools so all three original acceptance items are checked.

- [ ] **Step 8: Commit verification fixes**

If verification required changes:

```bash
git add src/api/agenda.rs src/api/openapi.rs tests/api_agenda_test.rs tests/openapi_contract.rs ui/src/api/schema.d.ts ui/src/api/tasks.ts ui/src/api/tasks.test.ts ui/src/api/keys.ts ui/src/api/board.test.ts ui/src/components/agenda ui/src/components/tasking/board-constants.tsx ui/src/components/tasking/__tests__/board-constants.test.tsx ui/src/components/tasking/TaskingScreen.tsx ui/src/components/ui/task-status-button.tsx ui/src/components/ui/__tests__/task-status-button.test.tsx ui/src/routes/agenda.tsx ui/src/routes/-agenda.test.tsx ui/src/editor/TaskPropertyPopover.tsx ui/src/editor/schema/elements/list.tsx ui/src/editor/__tests__/SlateEditor.task-properties.test.tsx ui/src/editor/schema/elements/list.taskProperties.test.tsx ui/src/lib/shortcuts.ts ui/src/lib/shortcuts.test.ts ui/src/docs
git commit -m "fix(agenda): address verification findings"
```

If no files changed, record the passing command outputs without creating an empty commit.

- [ ] **Step 9: Merge to develop and clean up**

Use the finishing-a-development-branch workflow. Merge the reviewed feature branch into `develop`, verify the merge result, and remove its isolated worktree. Do not create compatibility aliases or leave the feature branch as the integration result.
