# Tasking Board QoL Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Tasking board's seven bugs, add inline editing / search / quick-add / shortcuts, restore TIMELINE with a real `start` field, close the two cheap a11y items, and consolidate duplicated constants.

**Architecture:** Frontend work lives in `ui/src/components/tasking/` (React 19 + TanStack Query + Zustand + Tailwind v4 + react-aria-components). Backend work is confined to `src/api/board/` DTO additions and constant consolidation — no new endpoints. The OpenAPI schema (`ui/src/api/schema.d.ts`) is regenerated once, after the backend `start` field lands.

**Tech Stack:** Rust (Axum 0.8), React 19, TanStack Query v5, Zustand, react-aria-components, sonner (toasts), Vitest + React Testing Library, cargo test.

**Spec:** `docs/superpowers/specs/2026-08-11-tasking-qol-design.md`

## Global Constraints

- Verification gates before declaring any task complete: `cargo test` + `cargo clippy` (backend tasks), `bun run typecheck` + `bun run lint` + `bun run test` from `ui/` (frontend tasks). Report results explicitly.
- Vessel design language: zero border-radius, design tokens from `ui/src/main.css` (`--hot`, `--warn`, `--cool`, `--ink*`, `--rule`, `--bg*`, `--fs-xs`, `--fs-s`, `--pad`, `--row-h`). Never introduce hex colors or rounded corners.
- Path alias `#/` = `ui/src/`. Biome formatting (2-space, double quotes). Strict TS.
- UI test factories live in `ui/src/components/tasking/__tests__/fixtures.ts` — reuse them; check the file for exact factory names before writing tests.
- Single test file: `bun run test <file>` (from `ui/`). Single backend integration file: `cargo test --test api_board_test`.
- `bun run openapi` requires the server running (`cargo run -- serve`).
- Commit after every task with a conventional-commit message. Work happens on a feature branch/worktree off `develop` (created at execution time via superpowers:using-git-worktrees).

---

### Task 1: Board SSE invalidation

**Files:**
- Modify: `ui/src/hooks/useVaultEvents.ts:37-47`
- Test: `ui/src/hooks/useVaultEvents.test.tsx`

**Interfaces:**
- Consumes: `queryKeys.board.all` (`["board"]`) from `#/api/keys`.
- Produces: nothing new — behavioral fix only.

- [ ] **Step 1: Write the failing test**

In `useVaultEvents.test.tsx`, find the existing `index_changed` test that asserts `tasks`/`agenda` invalidation and add a sibling assertion (same arrange/act pattern as that test — reuse its EventSource mock):

```tsx
it("invalidates the board query on index_changed", async () => {
  // arrange/act identical to the neighbouring index_changed test in this file
  expect(invalidateSpy).toHaveBeenCalledWith(
    expect.objectContaining({ queryKey: ["board"] }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `ui/`): `bun run test src/hooks/useVaultEvents.test.tsx`
Expected: FAIL — no call with `queryKey: ["board"]`.

- [ ] **Step 3: Implement**

In `useVaultEvents.ts`, in the `index_changed` handler beside the existing `tasks`/`agenda` lines:

```ts
queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
queryClient.invalidateQueries({ queryKey: queryKeys.agenda.all });
queryClient.invalidateQueries({ queryKey: queryKeys.board.all });
```

- [ ] **Step 4: Run test to verify it passes** — same command, expected PASS. Run the full file to catch regressions.

- [ ] **Step 5: Commit**

```bash
git add ui/src/hooks/useVaultEvents.ts ui/src/hooks/useVaultEvents.test.tsx
git commit -m "fix(tasking): refresh board on vault index_changed events"
```

---

### Task 2: Mutation error toasts

**Files:**
- Modify: `ui/src/api/board.ts`
- Test: `ui/src/api/board.test.ts`

**Interfaces:**
- Consumes: `toast` from `sonner` (house pattern: `ui/src/api/bases.ts:276`).
- Produces: every board mutation hook surfaces failure via `toast.error`. Message strings (exact copy, used by tests): `"TASK EDIT FAILED — REVERTED"`, `"TASK CREATION FAILED"`, `"TASK DESTROY FAILED"`, `"CYCLE CREATION FAILED"`, `"CYCLE UPDATE FAILED"`.

- [ ] **Step 1: Write the failing tests**

In `board.test.ts` (mock sonner at module scope):

```ts
import { toast } from "sonner";
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

it("toasts when a patch fails and rolls back", async () => {
  // arrange: seed board cache, stub fetch to reject (follow the existing
  // usePatchTask rollback test in this file for the renderHook harness)
  // act: mutate, await settled
  expect(toast.error).toHaveBeenCalledWith("TASK EDIT FAILED — REVERTED");
  // existing rollback assertion stays
});

it("toasts when create fails", async () => {
  expect(toast.error).toHaveBeenCalledWith("TASK CREATION FAILED");
});
// analogous cases for useDeleteTask / useCreateCycle / usePatchCycle
```

- [ ] **Step 2: Run to verify FAIL** — `bun run test src/api/board.test.ts`

- [ ] **Step 3: Implement**

In `board.ts`: `import { toast } from "sonner";` then

```ts
// usePatchTask — extend the existing onError (rollback stays first):
onError: (_err, _vars, ctx) => {
  if (ctx?.previous !== undefined) {
    qc.setQueryData(queryKeys.board.all, ctx.previous);
  }
  toast.error("TASK EDIT FAILED — REVERTED");
},
// useCreateTask:
onError: () => toast.error("TASK CREATION FAILED"),
// useDeleteTask:
onError: () => toast.error("TASK DESTROY FAILED"),
// useCreateCycle:
onError: () => toast.error("CYCLE CREATION FAILED"),
// usePatchCycle:
onError: () => toast.error("CYCLE UPDATE FAILED"),
```

- [ ] **Step 4: Run to verify PASS**, then full file.

- [ ] **Step 5: Commit** — `fix(tasking): surface board mutation failures as toasts`

---

### Task 3: Firefox drag fix

**Files:**
- Modify: `ui/src/components/tasking/TaskCard.tsx:60-68`
- Test: `ui/src/components/tasking/__tests__/KanbanView.test.tsx`

**Interfaces:**
- Produces: `TaskCard` sets `dataTransfer` itself; the `onDragStart` prop signature is unchanged (`(e: React.DragEvent) => void`).

- [ ] **Step 1: Write the failing test**

```tsx
it("writes the task id to dataTransfer on drag start", () => {
  // render KanbanView with one task via fixtures
  const setData = vi.fn();
  fireEvent.dragStart(screen.getByTestId(`task-card-${task.id}`), {
    dataTransfer: { setData, effectAllowed: "" },
  });
  expect(setData).toHaveBeenCalledWith("text/plain", task.id);
});
```

- [ ] **Step 2: Run to verify FAIL** — `bun run test src/components/tasking/__tests__/KanbanView.test.tsx`

- [ ] **Step 3: Implement** — in `TaskCard.tsx` replace the passthrough:

```tsx
onDragStart={(e) => {
  // Firefox refuses to initiate an HTML5 drag without setData.
  e.dataTransfer.setData("text/plain", t.id);
  e.dataTransfer.effectAllowed = "move";
  onDragStart(e);
}}
```

- [ ] **Step 4: Run to verify PASS.** — full file.
- [ ] **Step 5: Commit** — `fix(tasking): set dataTransfer on drag start so Firefox can drag cards`

---

### Task 4: Single health-color helper

**Files:**
- Modify: `ui/src/components/tasking/board-constants.tsx` (add `healthColor`, rewrite `HealthDot` on it)
- Modify: `ui/src/components/tasking/BoardHeader.tsx:162-167` (delete local ternary)
- Test: `ui/src/components/tasking/__tests__/BoardHeader.test.tsx`

**Interfaces:**
- Produces: `export function healthColor(health: string): string` in `board-constants.tsx`. GREEN→`var(--cool)`, AMBER→`var(--warn)`, RED→`var(--hot)`, anything else→`var(--ink-mute)`.

- [ ] **Step 1: Failing test** — in `BoardHeader.test.tsx`, render with an active op whose `health: "NONE"`; assert the HEALTH `<b>` has `style.color === "var(--ink-mute)"` (today it renders `var(--cool)`).
- [ ] **Step 2: Run to verify FAIL** — `bun run test src/components/tasking/__tests__/BoardHeader.test.tsx`
- [ ] **Step 3: Implement**

```tsx
// board-constants.tsx
export function healthColor(health: string): string {
  if (health === "GREEN") return "var(--cool)";
  if (health === "AMBER") return "var(--warn)";
  if (health === "RED") return "var(--hot)";
  return "var(--ink-mute)";
}
```

`HealthDot` uses `healthColor(health)` for its background. In `BoardHeader.tsx` replace the `healthColor` local ternary with `import { healthColor } ...` and `healthColor(activeOp?.health ?? "")`.

- [ ] **Step 4: PASS + full tasking test dir.**
- [ ] **Step 5: Commit** — `fix(tasking): one health-color mapping with a muted unknown fallback`

---

### Task 5: DUE inputs become date fields

**Files:**
- Modify: `ui/src/components/tasking/NewTaskModal.tsx:257-266`, `ui/src/components/tasking/TaskEditPanel.tsx:484-492`
- Test: `ui/src/components/tasking/__tests__/NewTaskModal.test.tsx`, `__tests__/TaskEditPanel.test.tsx`

- [ ] **Step 1: Failing tests** — assert `screen.getByTestId("new-task-due")` and `getByTestId("edit-panel-due")` have attribute `type="date"` (jsdom does not enforce date parsing, so the attribute is the honest assertion; the browser enforces the rest).
- [ ] **Step 2: FAIL** — both files.
- [ ] **Step 3: Implement** — change `type="text"` → `type="date"` on both DUE inputs; drop the `placeholder="2026-12-31"`; keep the `hint="YYYY-MM-DD"`. Existing `fireEvent.change` tests keep working because they use ISO values.
- [ ] **Step 4: PASS** both files.
- [ ] **Step 5: Commit** — `fix(tasking): DUE inputs are date fields, matching cycle modals`

---

### Task 6: Hold toggle stops persisting the placeholder

**Files:**
- Modify: `ui/src/components/tasking/TaskEditPanel.tsx` (hold toggle at :548-553, reason input at :557-565)
- Test: `ui/src/components/tasking/__tests__/TaskEditPanel.test.tsx`

**Interfaces:**
- Produces: toggling on patches `{ hold: "BLOCKED" }`; the reason input receives focus with its content selected.

- [ ] **Step 1: Failing test**

```tsx
it("holds with BLOCKED and focuses the reason input selected", async () => {
  // render panel with an un-held task; click edit-panel-hold-toggle
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining("/tasks/"),
    expect.objectContaining({ body: JSON.stringify({ hold: "BLOCKED" }) }),
  );
  // re-render with task.hold = "BLOCKED" (optimistic board state)
  const reason = screen.getByTestId("edit-panel-hold-reason") as HTMLInputElement;
  expect(document.activeElement).toBe(reason);
  expect(reason.selectionStart).toBe(0);
  expect(reason.selectionEnd).toBe("BLOCKED".length);
});
```

- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement**

```tsx
const holdReasonRef = useRef<HTMLInputElement>(null);
const focusReasonOnHold = useRef(false);

// toggle onClick:
onClick={() => {
  if (!task.hold) focusReasonOnHold.current = true;
  patchNow({ hold: task.hold ? null : "BLOCKED" });
}}

// effect — fires when the optimistic patch flips task.hold on:
useEffect(() => {
  if (task.hold && focusReasonOnHold.current) {
    focusReasonOnHold.current = false;
    holdReasonRef.current?.focus();
    holdReasonRef.current?.select();
  }
}, [task.hold]);
```

Attach `ref={holdReasonRef}` to the reason input.

- [ ] **Step 4: PASS** full file.
- [ ] **Step 5: Commit** — `fix(tasking): hold toggle writes BLOCKED and selects the reason for editing`

---

### Task 7: Board error state gains RETRY

**Files:**
- Modify: `ui/src/components/tasking/TaskingScreen.tsx:61,142-148`
- Test: `ui/src/components/tasking/__tests__/TaskingScreen.test.tsx`

- [ ] **Step 1: Failing test** — stub `fetch` to reject once then resolve; render, await the error state, click `screen.getByRole("button", { name: /retry/i })`, assert the board renders (e.g. `kb-col-INTAKE` appears).
- [ ] **Step 2: FAIL** — `bun run test src/components/tasking/__tests__/TaskingScreen.test.tsx`
- [ ] **Step 3: Implement** — destructure `refetch` from `useBoard()`; error branch becomes:

```tsx
if (isError || !data) {
  return (
    <div className="cl-mono flex h-full flex-col items-center justify-center gap-[12px] text-[11px] uppercase tracking-[0.18em] text-[var(--hot)]">
      ERROR — board unavailable
      <button type="button" className="cl-btn" onClick={() => refetch()}>
        RETRY
      </button>
    </div>
  );
}
```

- [ ] **Step 4: PASS** full file.
- [ ] **Step 5: Commit** — `fix(tasking): retry button on board error state`

---

### Task 8: Slug-less operation guards

**Files:**
- Modify: `ui/src/components/tasking/NewTaskModal.tsx:194-200`, `TaskEditPanel.tsx:435-441`, `ScopeRail.tsx:127-137,219-221`
- Test: `__tests__/ScopeRail.test.tsx`, `__tests__/NewTaskModal.test.tsx`

**Interfaces:**
- Produces: `assignableOps` filtering rule — dropdowns only offer ops where `Boolean(op.project)`; ScopeRail badge predicate `t.project === opKey(op)`.

- [ ] **Step 1: Failing tests**

```tsx
// ScopeRail.test.tsx — op without project slug:
it("badge for a slug-less op matches what clicking reveals (zero)", () => {
  // one op with project: null, code "OP-X"; three tasks with project null
  // badge for OP-X row must show 0, not 3
});
// NewTaskModal.test.tsx:
it("omits slug-less operations from the OPERATION dropdown", () => {
  // operations = [slugged, slugless]; expect only the slugged option
});
```

- [ ] **Step 2: FAIL** both files.
- [ ] **Step 3: Implement**

```tsx
// NewTaskModal + TaskEditPanel, before the <select> render:
const assignableOps = operations.filter((op) => Boolean(op.project));
// map over assignableOps instead of operations in the dropdowns.

// ScopeRail per-op count (was: t.project === op.project — null===null bug):
const key = opKey(op);
const count = tasks.filter((t) => t.project === key).length;

// ScopeRail handleNewTasking — never leak an op code as a project preset:
const activeOp = operations.find((op) => opKey(op) === opFilter);
const project = activeOp?.project ?? undefined;
openTaskModal(project ? { project } : {});
```

- [ ] **Step 4: PASS** both files + `TaskEditPanel.test.tsx`.
- [ ] **Step 5: Commit** — `fix(tasking): slug-less ops can no longer misfile tasks; rail badges match their view`

---

### Task 9: CLOSED cycles leave the dropdowns

**Files:**
- Modify: `ui/src/components/tasking/NewTaskModal.tsx:203-216`, `TaskEditPanel.tsx:443-461`
- Test: `__tests__/NewTaskModal.test.tsx`, `__tests__/TaskEditPanel.test.tsx`

- [ ] **Step 1: Failing tests** — modal: with cycles `[ACTIVE S-1, CLOSED S-0]` only S-1 is an option. Panel: task currently in CLOSED S-0 → S-0 still listed (current value must stay representable); task not in it → S-0 absent.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement**

```tsx
// NewTaskModal:
const selectableCycles = cycles.filter((c) => c.state !== "CLOSED");
// TaskEditPanel:
const selectableCycles = cycles.filter(
  (c) => c.state !== "CLOSED" || c.code === task.cycle,
);
```

Map the dropdowns over `selectableCycles` (the `({c.state})` suffix already marks the closed current value).

- [ ] **Step 4: PASS** both files.
- [ ] **Step 5: Commit** — `fix(tasking): closed cycles are no longer assignment targets`

---

### Task 10: Backend `start` field (create + tri-state patch)

**Files:**
- Modify: `src/api/board/mod.rs:209-262` (both request DTOs), `src/api/board/tasks.rs` (create ~:111-116 region, patch ~:254-260 region)
- Test: `tests/api_board_test.rs`

**Interfaces:**
- Produces: `CreateTaskRequest.start: Option<String>`; `PatchTaskRequest.start: Option<Option<String>>` (tri-state, same serde attrs as `due`). Frontmatter key `"start"`. `BoardTask.start` already exists on the read side — no read changes.

- [ ] **Step 1: Write the failing tests** — in `tests/api_board_test.rs`, following the existing create/patch test shapes in that file:

```rust
#[tokio::test]
async fn create_task_with_start_round_trips() {
    // POST /api/vault/board/tasks {"title":"T","start":"2026-08-01","due":"2026-08-15"}
    // assert 201 body.start == Some("2026-08-01")
    // GET /api/vault/board → the task's start is "2026-08-01"
}

#[tokio::test]
async fn patch_task_start_tri_state() {
    // create without start → PATCH {"start":"2026-08-02"} → 200, start set
    // PATCH {"start":null} → 200, start cleared (absent from GET /board DTO)
    // PATCH {} → start unchanged
}
```

- [ ] **Step 2: Run to verify FAIL** — `cargo test --test api_board_test create_task_with_start patch_task_start`
Expected: compile error (unknown field) or assertion failure.

- [ ] **Step 3: Implement**

```rust
// mod.rs — CreateTaskRequest, after `due`:
    pub start: Option<String>,

// mod.rs — PatchTaskRequest, after the `due` field:
    /// Tri-state: absent = keep, null = clear, value = set.
    #[serde(default, deserialize_with = "deserialize_tri_state")]
    pub start: Option<Option<String>>,

// tasks.rs create_task — beside the `due` insert:
    if let Some(ref s) = body.start {
        meta.extra
            .insert("start".to_string(), toml::Value::String(s.clone()));
    }

// tasks.rs patch_task — beside the other tri-state applications:
    apply_tri_state(&mut meta, "start", &body.start);
```

- [ ] **Step 4: Run to verify PASS** — `cargo test --test api_board_test`, then `cargo clippy` and `cargo fmt`.
- [ ] **Step 5: Commit** — `feat(board): start date writable via create and tri-state patch`

---

### Task 11: OpenAPI regen + frontend `start` plumbing

**Files:**
- Regenerate: `ui/src/api/schema.d.ts` (`bun run openapi`, server running)
- Modify: `ui/src/api/board.ts:76-82` (`applyTaskPatch`), `NewTaskModal.tsx` (state + field + commit payload), `TaskEditPanel.tsx` (state + debounce + field)
- Test: `ui/src/api/board.test.ts`, `__tests__/NewTaskModal.test.tsx`, `__tests__/TaskEditPanel.test.tsx`

**Interfaces:**
- Consumes: Task 10's DTO fields (arrive via regenerated `schema.d.ts`).
- Produces: `data-testid="new-task-start"` and `data-testid="edit-panel-start"` date inputs.

- [ ] **Step 1: Regenerate the schema** — start `cargo run -- serve` in the background, run `bun run openapi` from `ui/`, stop the server. `git diff ui/src/api/schema.d.ts` must show `start` on both request types.
- [ ] **Step 2: Failing tests**
  - `board.test.ts`: `applyTaskPatch(board, id, { start: "2026-08-02" })` sets start; `{ start: null }` clears; absent keeps.
  - `NewTaskModal.test.tsx`: fill `new-task-start`, commit, assert POST body contains `"start":"2026-08-01"`.
  - `TaskEditPanel.test.tsx`: type into `edit-panel-start`, advance debounce timers, assert PATCH body `{"start":"2026-08-02"}`.
- [ ] **Step 3: Implement**

```ts
// applyTaskPatch — with the other tri-state lines:
    start: triState(task.start, "start"),
```

`NewTaskModal`: add `const [start, setStart] = useState("");`, reset on open, include `start: start.trim() || null` in the payload. Replace the OPERATOR/EST/DUE 3-col grid with two 2-col rows — `OPERATOR`+`EST`, then `START`+`DUE` — both dates `type="date"`.

`TaskEditPanel`: add `startVal` mirror + reset-on-task-change + a `useDebounced` block identical in shape to the `dueVal` one, patching `{ start: trimmed }`. Same two-row grid change (the 340px panel cannot fit 4 columns).

- [ ] **Step 4: PASS** all three files; `bun run typecheck`.
- [ ] **Step 5: Commit** — `feat(tasking): start date editable from the board`

---

### Task 12: TIMELINE restyle (Tailwind port)

**Files:**
- Modify: `ui/src/components/tasking/TimelineView.tsx:152-271`, `ui/src/components/tasking/timeline-math.ts` (named constants)
- Reference (read-only): `docs/pkm-redesign/project/styles-board.css` — the `.tl*` rules being ported
- Test: `__tests__/TimelineView.test.tsx`

**Interfaces:**
- Produces: TimelineView positions bars with real CSS. Class contract for tests: the row track element includes `relative`; every `tl-bar` button includes `absolute`.

- [ ] **Step 1: Failing test**

```tsx
it("positions bars absolutely inside a relative track", () => {
  // render a scheduled fixture (cycle with start+end, task with due)
  const bar = screen.getByTestId(`tl-bar-${task.id}`);
  expect(bar.className).toContain("absolute");
  expect(bar.parentElement?.className).toContain("relative");
});
```

- [ ] **Step 2: FAIL** — `bun run test src/components/tasking/__tests__/TimelineView.test.tsx` (bars today carry only bare `tl-bar` classes).
- [ ] **Step 3: Implement** — read each `.tl*` rule in `docs/pkm-redesign/project/styles-board.css` and translate to Tailwind on Vessel tokens, replacing every bare class. Required structural mapping (visual detail comes from the stylesheet):

```
.tl            → flex h-full flex-col overflow-auto
.tl-axis       → sticky top-0 z-[2] grid grid-cols-[240px_1fr] border-b border-[var(--rule)] bg-[var(--bg-2)]
.tl-axis-track → relative h-[34px] overflow-hidden
.tl-band       → absolute top-0 bottom-0 flex items-center gap-[6px] border-l border-r border-[var(--rule)] px-[6px]
                 state tint: ACTIVE → bg accent-mix, CLOSED → muted, PLANNED → transparent
.tl-grp-hd     → flex items-center gap-[8px] border-b border-[var(--ink-3)] bg-[var(--bg)] px-[var(--pad)] py-[6px]
.tl-row        → grid grid-cols-[240px_1fr] border-b border-dotted border-[var(--rule)]
.tl-row-label  → flex min-w-0 items-center gap-[7px] px-[var(--pad)] py-[6px]
.tl-row-track  → relative min-h-[30px]
.tl-grid       → absolute top-0 bottom-0 w-px bg-[var(--rule)]
.tl-bar        → absolute top-1/2 h-[16px] -translate-y-1/2 flex items-center gap-[5px] border px-[5px]
                 status colors: FIELD → var(--cool) border, REVIEW → var(--warn), SEALED → var(--ink-faint), hold → var(--hot) dashed
.tl-bar-pri    → h-[8px] w-[3px], background from the shared priority map
.tl-foot       → flex items-center gap-[10px] border-t border-[var(--rule)] px-[var(--pad)] py-[7px]
```

Keep every `data-testid` and inline `left`/`width` untouched. In `timeline-math.ts` name the literals:

```ts
export const TL_WINDOW_PAD_DAYS = 2;
export const TL_DEFAULT_BAR_DAYS = 2;
```

and use them in `windowOf`/`taskRange`.

- [ ] **Step 4: PASS** full file. Then a visual check: `bun run dev` against the local vault, open TIMELINE, compare against the prototype JSX (`docs/pkm-redesign/project/board-modes.jsx:301-390`).
- [ ] **Step 5: Commit** — `fix(tasking): timeline actually renders — port tl-* prototype styles to Tailwind`

---

### Task 13: InlineEditPopover component

**Files:**
- Create: `ui/src/components/tasking/InlineEditPopover.tsx`
- Test: `ui/src/components/tasking/__tests__/InlineEditPopover.test.tsx`

**Interfaces:**
- Consumes: `usePatchTask` from `#/api/board`; `DispositionRow`, `PriorityRow` from `./fields`; house `Popover` (`#/components/ui/popover`); RAC `DialogTrigger`, `Button`, `Dialog`.
- Produces:

```tsx
export function InlineEditPopover({
  task,
  field,           // "status" | "priority"
  children,        // the visual chip (PriChip / StatePip + label)
  testIdPrefix,    // e.g. "kb", "bk", "cv" — testid = `${testIdPrefix}-inline-${field}-${task.id}`
}: {
  task: BoardTask;
  field: "status" | "priority";
  children: React.ReactNode;
  testIdPrefix: string;
}): JSX.Element
```

- [ ] **Step 1: Failing tests**

```tsx
it("patches status from the popover without opening the panel", async () => {
  const onCardClick = vi.fn();
  render(
    <div onClick={onCardClick}>
      <InlineEditPopover task={task} field="status" testIdPrefix="kb">
        <span>pip</span>
      </InlineEditPopover>
    </div>,
  );
  await user.click(screen.getByTestId(`kb-inline-status-${task.id}`));
  await user.click(screen.getByTestId("inline-status-FIELD"));
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining(`/tasks/${task.id}`),
    expect.objectContaining({ body: JSON.stringify({ status: "FIELD" }) }),
  );
  expect(onCardClick).not.toHaveBeenCalled();
});
```

Plus: Escape closes the popover; a priority-field variant patches `{ priority: "P1" }`.

- [ ] **Step 2: FAIL** (module does not exist).
- [ ] **Step 3: Implement**

```tsx
import { useState } from "react";
import { Button, Dialog, DialogTrigger } from "react-aria-components";
import type { BoardTask } from "#/api/board";
import { usePatchTask } from "#/api/board";
import { Popover } from "#/components/ui/popover";
import { DispositionRow, PriorityRow } from "./fields";

export function InlineEditPopover({ task, field, children, testIdPrefix }: /* as above */) {
  const [open, setOpen] = useState(false);
  const patch = usePatchTask();
  const commit = (value: string) => {
    patch.mutate({ id: task.id, patch: { [field]: value } });
    setOpen(false);
  };
  return (
    // span guard: chip interaction must never bubble into the card's onClick
    <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <DialogTrigger isOpen={open} onOpenChange={setOpen}>
        <Button
          className="cursor-pointer outline-none focus-visible:outline-[1px] focus-visible:outline-[var(--hot)]"
          data-testid={`${testIdPrefix}-inline-${field}-${task.id}`}
          aria-label={`Change ${field}`}
        >
          {children}
        </Button>
        <Popover hideArrow placement="bottom start">
          <Dialog
            aria-label={`Set ${field}`}
            className="w-[320px] border border-[var(--ink-3)] bg-[var(--bg)] p-[8px] outline-none"
          >
            {field === "status" ? (
              <DispositionRow value={task.status} onChange={commit} testIdPrefix="inline" />
            ) : (
              <PriorityRow value={task.priority} onChange={commit} testIdPrefix="inline" />
            )}
          </Dialog>
        </Popover>
      </DialogTrigger>
    </span>
  );
}
```

(`DispositionRow` testids come out as `inline-status-<COL>` / `inline-priority-<P>` — matching Step 1.)

- [ ] **Step 4: PASS** full file.
- [ ] **Step 5: Commit** — `feat(tasking): inline status/priority popover component`

---

### Task 14: Wire inline editing into the three views

**Files:**
- Modify: `TaskCard.tsx` (priority badge → trigger; add a `StatePip` status trigger beside it), `BacklogView.tsx` (DISPOSITION cell → status trigger; add a `PriChip` priority trigger in the TASKING cell), `CycleView.tsx` (row `PriChip` → priority trigger; add a `StatePip` status trigger after the code)
- Test: `__tests__/KanbanView.test.tsx`, `__tests__/BacklogView.test.tsx`, `__tests__/CycleView.test.tsx`

**Interfaces:**
- Consumes: `InlineEditPopover` (Task 13). testIdPrefixes: `kb`, `bk`, `cv`.

- [ ] **Step 1: Failing tests** — one per view, same shape: click the trigger (`kb-inline-priority-${id}`, `bk-inline-status-${id}`, `cv-inline-priority-${id}`), pick a value, assert the PATCH body, and assert the edit panel did NOT open (`setEditTaskId`/row click spy uncalled).
- [ ] **Step 2: FAIL** all three.
- [ ] **Step 3: Implement** — wrap the existing chip markup:

```tsx
// TaskCard top row (replaces the bare priority span):
<InlineEditPopover task={t} field="priority" testIdPrefix="kb">
  <span className="cl-mono border px-[4px] py-0 text-[var(--fs-xs)] tracking-[0.08em]"
        style={{ color: priColor, borderColor: priColor }}>
    {t.priority}
  </span>
</InlineEditPopover>
<InlineEditPopover task={t} field="status" testIdPrefix="kb">
  <StatePip col={t.status} />
</InlineEditPopover>
```

BacklogView: the DISPOSITION cell content (`StatePip` + label) goes inside a status-field popover; a `PriChip` trigger is inserted at the start of the TASKING cell. NOTE: the row itself is a `<button>` — nested buttons are invalid HTML and break RAC. Convert the row to a `<div role="button" tabIndex={0}` with an Enter/Space keydown calling the existing onClick (this pre-figures Task 17's card treatment; reuse the same handler shape). CycleView rows have the same nested-button constraint — same conversion.

- [ ] **Step 4: PASS** all three files + `TaskEditPanel.test.tsx` (unchanged behavior).
- [ ] **Step 5: Commit** — `feat(tasking): status and priority editable inline from all board views`

---

### Task 15: Board filter — state + predicate

**Files:**
- Create: `ui/src/components/tasking/board-filter.ts`
- Modify: `ui/src/store/board.ts` (ephemeral `filter` state — NOT in `partialize`)
- Test: `ui/src/components/tasking/__tests__/board-filter.test.ts`

**Interfaces:**
- Produces:

```ts
export interface BoardFilter { text: string; pris: string[]; holdOnly: boolean; }
export const EMPTY_FILTER: BoardFilter = { text: "", pris: [], holdOnly: false };
export function isFilterActive(f: BoardFilter): boolean;
export function applyBoardFilter(tasks: BoardTask[], f: BoardFilter): BoardTask[];
```

Store additions: `filter: BoardFilter`, `setFilter(filter: BoardFilter)`.

- [ ] **Step 1: Failing tests** — pure-function cases: case-insensitive text match on title, code, tags, assignee; no match on other fields; `pris: ["P0","P1"]` keeps only those; `holdOnly` keeps `t.hold` truthy; composition of all three; `EMPTY_FILTER` returns input array unchanged (same reference).
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement**

```ts
export function isFilterActive(f: BoardFilter): boolean {
  return f.text.trim() !== "" || f.pris.length > 0 || f.holdOnly;
}

export function applyBoardFilter(tasks: BoardTask[], f: BoardFilter): BoardTask[] {
  if (!isFilterActive(f)) return tasks;
  const q = f.text.trim().toLowerCase();
  return tasks.filter((t) => {
    if (f.holdOnly && !t.hold) return false;
    if (f.pris.length > 0 && !f.pris.includes(t.priority)) return false;
    if (q === "") return true;
    const hay = [t.title, t.code, t.assignee ?? "", ...t.tags].join(" ").toLowerCase();
    return hay.includes(q);
  });
}
```

Store: add the two members with `filter: EMPTY_FILTER` default; `partialize` stays untouched (filter is ephemeral by spec).

- [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** — `feat(tasking): board filter predicate and ephemeral store state`

---

### Task 16: Filter UI + composition

**Files:**
- Modify: `ui/src/components/tasking/BoardHeader.tsx` (filter row), `TaskingScreen.tsx` (compose + counts)
- Test: `__tests__/BoardHeader.test.tsx`, `__tests__/TaskingScreen.test.tsx`

**Interfaces:**
- Consumes: Task 15's store fields + `applyBoardFilter`.
- Produces: `id="tasking-filter"` + `data-testid="board-filter-input"` text input; P0–P3 + HOLD toggle buttons (`data-testid="board-filter-pri-P0"` … `"board-filter-hold"`); results line `data-testid="board-filter-count"` rendering `N OF M` only when `isFilterActive`.

- [ ] **Step 1: Failing tests** — TaskingScreen: seed 3 tasks, type "alpha" into the input → only matching card remains, count reads `01 OF 03`; click P0 toggle → composes; clear → all back, count line gone. BoardHeader: toggles flip aria-pressed.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement** — BoardHeader gains a bottom strip (below the top strip, above the op-meta line):

```tsx
const filter = useBoardStore((s) => s.filter);
const setFilter = useBoardStore((s) => s.setFilter);
// input:
<input
  id="tasking-filter"
  data-testid="board-filter-input"
  type="text"
  placeholder="FILTER…"
  className="cl-mono w-[220px] border border-[var(--rule)] bg-transparent px-[8px] py-[4px] text-[var(--fs-xs)] uppercase tracking-[0.1em] text-[var(--ink)] outline-none placeholder:text-[var(--ink-4)] focus:border-[var(--hot)]"
  value={filter.text}
  onChange={(e) => setFilter({ ...filter, text: e.target.value })}
  onKeyDown={(e) => {
    if (e.key === "Escape") {
      setFilter({ ...filter, text: "" });
      e.currentTarget.blur();
      e.stopPropagation(); // don't let Escape reach the edit panel's window listener
    }
  }}
/>
// one toggle per PRI_ORDER entry + HOLD:
<button type="button" aria-pressed={filter.pris.includes(p)} data-testid={`board-filter-pri-${p}`}
  onClick={() => setFilter({ ...filter,
    pris: filter.pris.includes(p) ? filter.pris.filter((x) => x !== p) : [...filter.pris, p] })}>
  {p}
</button>
```

TaskingScreen memo: `const filtered = applyBoardFilter(filterTasks(data.tasks, data.operations, opFilter), filter);` — `visibleTasks` becomes `filtered`; pass `opFilteredCount` and `filteredCount` to BoardHeader for the `N OF M` line (`pad2(filtered.length)} OF ${pad2(opFiltered.length)`).

- [ ] **Step 4: PASS** both files + KanbanView/BacklogView/CycleView/TimelineView suites (they receive already-filtered tasks — no changes expected).
- [ ] **Step 5: Commit** — `feat(tasking): text + priority + hold filtering across all board modes`

---

### Task 17: Quick-add rows

**Files:**
- Create: `ui/src/components/tasking/QuickAddRow.tsx`
- Modify: `KanbanView.tsx` (row at each column-body bottom), `BacklogView.tsx` (row above the header)
- Test: `__tests__/QuickAddRow.test.tsx`, extend `__tests__/KanbanView.test.tsx`, `__tests__/BacklogView.test.tsx`

**Interfaces:**
- Consumes: `useCreateTask`.
- Produces:

```tsx
export function QuickAddRow({ preset, testId }: {
  preset: { status?: string; project?: string; cycle?: string };
  testId: string;   // e.g. `qa-INTAKE`, `qa-backlog`
}): JSX.Element
```

- [ ] **Step 1: Failing tests** — type a title + Enter → POST body has the title, preset status/project, and `priority: null`; input clears and keeps focus on success; Enter with empty/whitespace title → no fetch; Escape clears and blurs.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement**

```tsx
export function QuickAddRow({ preset, testId }: QuickAddRowProps) {
  const [title, setTitle] = useState("");
  const create = useCreateTask();
  const commit = () => {
    const t = title.trim();
    if (!t || create.isPending) return;
    create.mutate(
      {
        title: t,
        status: preset.status ?? null,
        project: preset.project ?? null,
        cycle: preset.cycle ?? null,
        priority: null, assignee: null, estimate: null,
        due: null, start: null, tags: null, link: null, checklist: null,
      },
      { onSuccess: () => setTitle("") },
    );
  };
  return (
    <input
      type="text"
      data-testid={testId}
      className="cl-mono w-full border border-dashed border-[var(--rule)] bg-transparent px-[8px] py-[6px] text-[var(--fs-xs)] uppercase tracking-[0.08em] text-[var(--ink)] outline-none placeholder:text-[var(--ink-4)] focus:border-[var(--hot)] focus:border-solid"
      placeholder="+ ADD"
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { setTitle(""); e.currentTarget.blur(); e.stopPropagation(); }
      }}
    />
  );
}
```

KanbanView column body, after the items map: `<QuickAddRow preset={activeProject ? { status: col.id, project: activeProject } : { status: col.id }} testId={`qa-${col.id}`} />`. BacklogView, above the header row: `<QuickAddRow preset={{}} testId="qa-backlog" />`.

- [ ] **Step 4: PASS** all three files.
- [ ] **Step 5: Commit** — `feat(tasking): quick-add rows in kanban columns and backlog`

---

### Task 18: NewTaskModal — required title + dirty-dismiss guard

**Files:**
- Modify: `NewTaskModal.tsx:97-136`, `BoardModalFrame.tsx` (new `isDismissable` prop)
- Test: `__tests__/NewTaskModal.test.tsx`, `__tests__/BoardModalFrame.test.tsx`

**Interfaces:**
- Produces: `BoardModalFrameProps.isDismissable?: boolean` (default `true`). Commit button disabled while `title.trim() === ""`; the `"UNTITLED TASKING"` fallback is deleted.

- [ ] **Step 1: Failing tests** — commit button `disabled` when title empty and no fetch fires on click; backdrop click with a dirty field does NOT close (modal still in DOM); backdrop click on a pristine modal closes; Escape always closes.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement**

```tsx
// BoardModalFrame: add prop, thread through:
isDismissable?: boolean;
// ...
<ModalOverlay isOpen isDismissable={isDismissable ?? true} ...>

// NewTaskModal:
const dirty =
  title !== "" || assignee !== "" || estimate !== "" || due !== "" ||
  start !== "" || tags !== "" || checklist !== "" || link !== "";
const commit = () => {
  const finalTitle = title.trim();
  if (!finalTitle) return;           // was: || "UNTITLED TASKING"
  ...
};
// frame: <BoardModalFrame ... isDismissable={!dirty}>
// commit button: disabled={create.isPending || title.trim() === ""}
```

- [ ] **Step 4: PASS** both files.
- [ ] **Step 5: Commit** — `fix(tasking): required title, and dirty creation forms survive backdrop clicks`

---

### Task 19: Tasking shortcuts + dispatcher guards

**Files:**
- Modify: `ui/src/lib/shortcuts.ts` (group `"Tasking"`, five entries), `ui/src/hooks/useGlobalShortcuts.tsx` (bindings + two guards)
- Test: the existing shortcut/dispatcher test files (locate with `rg -l "useGlobalShortcuts|matchesChord" ui/src --glob '*test*'`), extend in place

**Interfaces:**
- Produces registry ids: `tasking.newTask` (`n`), `tasking.modeCard` (`1`), `tasking.modeBacklog` (`2`), `tasking.modeCycle` (`3`), `tasking.modeTimeline` (`4`), `tasking.focusFilter` (`/`), `tasking.toggleRail` (`[`) — all bare-key chords, `group: "Tasking"`, `scope: "global"`, `note: "tasking view"`. Exposed helper `isEditableTarget(t: EventTarget | null): boolean` from `useGlobalShortcuts.tsx`.

- [ ] **Step 1: Failing tests**

```tsx
it("N on /tasking opens the task modal", ...)        // location stub /tasking
it("2 switches to backlog mode", ...)                 // asserts useBoardStore mode
it("bare keys do nothing when typing in an input", ...) // target = <input>
it("no global shortcut fires while a dialog is open", ...) // append [role=dialog] div, fire ⌘N, inscribe spy uncalled
it("[ toggles the rail", ...)
```

- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement**

`shortcuts.ts`: extend `ShortcutGroup` union with `"Tasking"`, append it to `GROUP_ORDER`, add the seven entries (chords: `{ key: "n" }`, `{ key: "1" }` … `{ key: "4" }`, `{ key: "/" }`, `{ key: "[" }` — no `mod`).

`useGlobalShortcuts.tsx`:

```tsx
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    t.isContentEditable
  );
}
const inTasking = () => window.location.pathname.startsWith("/tasking");
// bindings (uses useBoardStore.getState() — no re-render coupling):
"tasking.newTask":      { when: inTasking, run: () => useBoardStore.getState().openTaskModal({}) },
"tasking.modeCard":     { when: inTasking, run: () => useBoardStore.getState().setMode("card") },
"tasking.modeBacklog":  { when: inTasking, run: () => useBoardStore.getState().setMode("backlog") },
"tasking.modeCycle":    { when: inTasking, run: () => useBoardStore.getState().setMode("cycle") },
"tasking.modeTimeline": { when: inTasking, run: () => useBoardStore.getState().setMode("timeline") },
"tasking.focusFilter":  { when: inTasking, run: () => document.getElementById("tasking-filter")?.focus() },
"tasking.toggleRail":   { when: inTasking, run: () => {
  const s = useBoardStore.getState(); s.setRailOpen(!s.railOpen);
} },
// dispatcher, before the id loop:
if (document.querySelector('[role="dialog"]')) return;
// inside the loop, after matchesChord:
const chord = SHORTCUTS[id].chord;
const bareKey = !chord.mod && !chord.ctrl && !chord.alt;
if (bareKey && isEditableTarget(e.target)) continue;
```

- [ ] **Step 4: PASS** dispatcher tests + `bun run test src/lib` + spot-check ⌘/ help modal test still green.
- [ ] **Step 5: Commit** — `feat(tasking): board shortcuts (N, 1-4, /, [) with editable-target and open-dialog guards`

---

### Task 20: TaskCard keyboard activation + dossier button

**Files:**
- Modify: `TaskCard.tsx:60-69,157-167`
- Test: `__tests__/KanbanView.test.tsx`

- [ ] **Step 1: Failing tests** — card has `role="button"` and `tabIndex=0`; `fireEvent.keyDown(card, { key: "Enter" })` and `{ key: " " }` both trigger the edit-panel open spy; the dossier link is a `<button>` and Enter on it calls `onOpenDossier` without opening the panel.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement**

```tsx
// card root div gains:
role="button"
tabIndex={0}
onKeyDown={(e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    onClick();
  }
}}
// dossier span → button:
<button
  type="button"
  className="cursor-pointer border-b border-dotted border-[var(--cool)] text-[var(--cool)] hover:bg-[var(--cool)] hover:text-[var(--bg)]"
  onClick={(e) => { e.stopPropagation(); onOpenDossier?.(t.link!); }}
>
  {t.link}
</button>
```

- [ ] **Step 4: PASS** full file. Update `docs/superpowers/plans/followup-tasking-a11y.md` item 1 → done (cite this task).
- [ ] **Step 5: Commit** — `fix(tasking): kanban cards and dossier links operable by keyboard`

---

### Task 21: TaskEditPanel focus containment

**Files:**
- Modify: `TaskEditPanel.tsx:202-212,333-353`
- Test: `__tests__/TaskEditPanel.test.tsx`

**Interfaces:**
- Consumes: `FocusScope` from `react-aria` (already a transitive dependency of react-aria-components; verify with `bun pm ls react-aria` and add to `ui/package.json` if absent).

- [ ] **Step 1: Failing test** — open the panel, `await user.tab()` repeatedly for more elements than the panel contains, assert `document.activeElement` is always inside `screen.getByTestId("edit-panel")`; close, assert focus restored to the opener.
- [ ] **Step 2: FAIL** (Tab escapes to the board today).
- [ ] **Step 3: Implement** — wrap the panel contents:

```tsx
import { FocusScope } from "react-aria";
// replace the hand-rolled focus useEffect (keep the Escape listener) with:
<FocusScope contain restoreFocus autoFocus>
  <div ref={panelRef} tabIndex={-1} ... role="dialog" aria-modal="true" aria-label="Edit Tasking">
    {/* existing panel content */}
  </div>
</FocusScope>
```

Delete the manual `previouslyFocused` effect (FocusScope's `restoreFocus` replaces it). The scrim div stays outside the scope.

- [ ] **Step 4: PASS** full file. Update followup-tasking-a11y.md item 3 → done; note item 2 (keyboard DnD) remains open.
- [ ] **Step 5: Commit** — `fix(tasking): edit panel traps focus while open`

---

### Task 22: Frontend vocabulary single-sourcing

**Files:**
- Modify: `board-constants.tsx` (add `PRI_COLOR`, delete `COL_LABEL`), `TaskCard.tsx:14-26`, `TaskEditPanel.tsx:52-64`, `fields.tsx:62-78,140`, `BacklogView.tsx:138-147,205`, `CycleView.tsx:360`, `TimelineView.tsx:248`, `TaskingScreen.tsx` (thread `colLabel`), `store/board.ts:4` + `board-constants.tsx:66-71` (MODES typed by `BoardMode`)
- Test: existing suites (label sources change; assertions on rendered labels stay green because the server fixtures carry the same labels)

**Interfaces:**
- Produces:

```tsx
// board-constants.tsx
export const PRI_COLOR: Record<string, { bar: string; text: string }> = {
  P0: { bar: "var(--hot)",  text: "var(--hot)" },
  P1: { bar: "var(--warn)", text: "var(--warn)" },
  P2: { bar: "var(--cool)", text: "var(--cool)" },
  P3: { bar: "var(--ink-4)", text: "var(--ink-mute)" },
};
export function priColor(pri: string): { bar: string; text: string } {
  return PRI_COLOR[pri] ?? { bar: "var(--ink-3)", text: "var(--ink-mute)" };
}
export type ColLabelFn = (id: string) => string;
```

`DispositionRow` gains `colLabel?: ColLabelFn` (falls back to the column id when absent). `BacklogView`/`CycleView`/`TimelineView`/`NewTaskModal`/`TaskEditPanel` receive the same `colLabel: ColLabelFn` prop, built once in `TaskingScreen` and passed straight through to `DispositionRow` where used:

```tsx
const colLabel: ColLabelFn = useMemo(() => {
  const m = new Map(data?.columns.map((c) => [c.id, c.label] as const) ?? []);
  return (id) => m.get(id) ?? id;
}, [data]);
```

- [ ] **Step 1: Failing test** — in `TaskingScreen.test.tsx`, serve a board fixture whose FIELD column label is `"DEPLOYED"`; switch to BACKLOG mode; assert a FIELD-status row renders `DEPLOYED` (today it renders the hardcoded `IN-FIELD`).
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement** — add `PRI_COLOR`/`priColor`; delete `PRI_BAR_COLOR`/`PRI_TEXT_COLOR` from TaskCard and TaskEditPanel and the inline ternary in BacklogView's group header (all import `priColor`); derive `PRI_ON_STYLE`/`PRI_OFF_STYLE` in `fields.tsx` from `PRI_COLOR` (P3 off-state keeps `borderColor: var(--rule)` as an explicit exception). Delete `COL_LABEL`; thread `colLabel` per the interface block; `DispositionRow` renders `colLabel?.(colId) ?? colId`. Type `MODES` entries as `{ id: BoardMode; ... }` (import the union type; `satisfies` keeps literal inference).
- [ ] **Step 4: PASS** — full tasking suite + typecheck (threading is compile-checked).
- [ ] **Step 5: Commit** — `refactor(tasking): single priority color map; column labels come from the server`

---

### Task 23: Density tokens + micro-polish

**Files:**
- Modify: `BoardHeader.tsx`, `ScopeRail.tsx` (font-size literals → tokens), `BacklogView.tsx:86,130` (`--row-h` fallback), `KanbanView.tsx:142` (`type="button"`), `TaskCard.tsx:136-147` (tags +N), `BacklogView.tsx` (empty state), `BacklogView.tsx:191-193` / `CycleView.tsx:402-404` / `ScopeRail.tsx:238-240` (`title` attrs), `TaskingScreen.tsx:200` (stale comment), `NewTaskModal.tsx:88` / `NewCycleModal.tsx:119` / `TaskEditPanel.tsx:191` (biome-ignore), `TaskEditPanel.tsx:223-291` (`DEBOUNCE_MS`), `BoardModalFrame.tsx` + the four modals (ESC chip + width variants)
- Test: `__tests__/BacklogView.test.tsx` (empty state), `__tests__/KanbanView.test.tsx` (tag overflow), `__tests__/BoardModalFrame.test.tsx` (ESC chip)

**Interfaces:**
- Produces (in `BoardModalFrame.tsx`):

```tsx
/** Shared modal width variants — the only sizes board modals use. */
export const BOARD_MODAL_WIDTHS = {
  task: "w-[660px]",
  cycle: "w-[600px]",
  confirm: "w-[460px]",
} as const;
/** The header ESC chip every board modal renders (copy-pasted today). */
export function ModalEscChip({ onClose, testId }: { onClose: () => void; testId: string }): JSX.Element;
```

and in `TaskEditPanel.tsx`: `const DEBOUNCE_MS = 300;` replacing the seven bare `300` literals.

- [ ] **Step 1: Failing tests** — BacklogView with `tasks={[]}` renders `data-testid="bk-empty"` with `— NONE —`; TaskCard with 5 tags renders 3 chips plus a `+2` chip (`data-testid` `task-tags-more-${id}`).
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement**
  - `text-[9px]` → `text-[var(--fs-xs)]`; `text-[10px]`/`text-[11px]` → `text-[var(--fs-s)]` throughout BoardHeader and ScopeRail (leave the 20-22px display numerals alone — they are `cl-display` scale, not chrome).
  - `var(--row-h, 32px)` → `var(--row-h)` and `var(--pad, 12px)` → `var(--pad)` (tokens are always defined in `main.css`; stale fallbacks lie).
  - Tags: `{t.tags.length > 3 && (<span data-testid={`task-tags-more-${t.id}`} className="cl-mono border border-[var(--rule)] px-[4px] text-[var(--fs-xs)] text-[var(--ink-3)]">+{t.tags.length - 3}</span>)}`.
  - Backlog empty state (after the header row, when `groups.length === 0`): reuse KanbanView's dashed `— NONE —` block with `data-testid="bk-empty"`.
  - `title={t.title}` on the truncated BacklogView title span, `title={op.name}` on ScopeRail op names, `title={t.title}` on CycleView row titles.
  - `// eslint-disable-line react-hooks/exhaustive-deps` → `// biome-ignore lint/correctness/useExhaustiveDependencies: reinitialise only on open` (×3).
  - Add `type="button"` to the KanbanView `+` header button. Delete the stale `{/* Body router — Tasks 9-12 ... */}` comment.
  - `const DEBOUNCE_MS = 300;` beside `DESTROY_DISARM_MS` in TaskEditPanel; all seven `useDebounced(..., 300, ...)` call sites use it.
  - Extract `ModalEscChip` into BoardModalFrame.tsx (markup copied verbatim from `NewTaskModal.tsx:159-166`, parameterized by `onClose`/`testId`); replace the four copy-pasted chips (`NewTaskModal.tsx:159-166`, `NewCycleModal.tsx:174-181`, `OpenCycleModal.tsx:83-90`, `SealCycleModal.tsx:108-115`). Replace the four inline width strings with `BOARD_MODAL_WIDTHS.task` / `.cycle` / `.confirm`.
- [ ] **Step 4: PASS** — full tasking suite; then `bun run lint` (biome-ignore syntax is checked here).
- [ ] **Step 5: Commit** — `polish(tasking): density tokens, tag overflow, backlog empty state, tooltips`

---

### Task 24: Backend constant consolidation

**Files:**
- Create: `src/vault/board_vocab.rs` (+ `mod board_vocab;` in `src/vault/mod.rs`)
- Modify: `src/api/board/tasks.rs:51,54,73-76`, `src/api/board/read.rs` (the two `"INTAKE"`/`"P2"` default sites + SQL kind literals), `src/api/board/mod.rs:313`, `src/api/board/cycles.rs` (SQL kind literals, path building), `src/vault/task_history.rs:53`
- Test: `cargo test` (behavior-identical — the whole suite is the regression harness)

**Interfaces:**
- Produces (in the vault layer so `task_history.rs` can use it without an api→vault dependency inversion):

```rust
// src/vault/board_vocab.rs
//! Board vocabulary shared by the API layer and the vault history snapshotter.
pub const DEFAULT_STATUS: &str = "INTAKE";
pub const DEFAULT_PRIORITY: &str = "P2";
```

- [ ] **Step 1: Confirm the suite is green first** — `cargo test` (this is a pure refactor; a green baseline is the "failing test" equivalent).
- [ ] **Step 2: Implement**
  - Replace the four default literals with `crate::vault::board_vocab::{DEFAULT_STATUS, DEFAULT_PRIORITY}` (tasks.rs create path, both read.rs sites, task_history.rs:53).
  - Path building: `format!("{}/{p}/{code}.md", Kind::Task.canonical_folder())` / `format!("{}/{code}.md", Kind::Task.canonical_folder())` in tasks.rs; the cycle equivalent with `Kind::Cycle.canonical_folder()` in cycles.rs (mirror how `src/vault/task_history.rs:206` already does it).
  - SQL kind literals: `"... WHERE kind = 'TASK'"` → `params![Kind::Task.as_str()]` with `?` placeholders, at the nine sites (`mod.rs:313`, `read.rs:60,132,384`, `cycles.rs:186,289`, `tasks.rs:202` — plus the two remaining read sites flagged by `rg "'TASK'|'CYCLE'|'PROJECT'" src/api/board/`). Verify `Kind::as_str` exists (`src/vault/kind.rs`); if the method is named differently, use the existing name — do not add a duplicate.
- [ ] **Step 3: Verify** — `cargo test && cargo clippy && cargo fmt --check`; `rg '"INTAKE"|"P2"' src/` must show only `board_vocab.rs` (plus test fixtures).
- [ ] **Step 4: Commit** — `refactor(board): single source for defaults, kind folders, and SQL kind literals`

---

### Task 25: Full gates + integration verification

**Files:**
- Modify: none expected — fix whatever the gates surface.

- [ ] **Step 1: Backend gates** — `cargo test`, `cargo clippy`, `cargo fmt --check`.
- [ ] **Step 2: Frontend gates** — from `ui/`: `bun run typecheck`, `bun run lint`, `bun run test`.
- [ ] **Step 3: Live smoke** — `cargo run -- serve` + `bun run dev`: create a task via quick-add, filter it, inline-edit its priority, drag it a column right, open TIMELINE and confirm bars render positioned, edit its start date, press `N`/`2`/`/`/`[`, fail a patch (stop the server mid-edit) and confirm the toast.
- [ ] **Step 4: Docs** — confirm `followup-tasking-a11y.md` reflects items 1+3 done / 2 open; skim `ui/src/docs/content/` for tasking docs that mention DUE free-text or missing shortcuts and update if present.
- [ ] **Step 5: Commit any fixes** — `chore(tasking): verification gate fixes`, then hand off per superpowers:finishing-a-development-branch (merge to `develop`, clean up the worktree).
