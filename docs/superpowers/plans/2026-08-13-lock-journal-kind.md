# Lock Journal Kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an existing resolved Journal classification immutable through API/MCP assignment and expose that invariant through a disabled Folio kind control.

**Architecture:** A shared assignment-policy helper in `src/api/pages.rs` validates the existing resolved kind before either single-page or atomic bulk metadata preparation. `KindSelect` gains an optional immutable state implemented with React Aria's disabled semantics; Folio enables it only for resolved `JOURNAL` pages.

**Tech Stack:** Rust, Axum, Tokio integration tests, React 19, TypeScript, React Aria Components, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-13-lock-journal-kind-design.md`

## Global Constraints

- Resolve the current kind from current path plus declared `type`; do not infer immutability from path alone.
- Reject only `JOURNAL` to a different kind; permit same-kind assignment, assignment into `JOURNAL`, and project-only mutation.
- Bulk rejection must occur before publication so the request remains atomic.
- Error text must contain `journal kind cannot be changed`.
- Folio must show `JOURNAL · fixed` with the accessible description `Journal kind cannot be changed.`
- Do not add an override, compatibility shim, dependency, or unrelated refactor.

---

### Task 1: Enforce Journal Assignment Invariant

**Files:**
- Modify: `src/api/pages.rs:1429-1493,1540-1585`
- Test: `tests/api_test.rs` beside existing page-assignment and bulk-assignment tests

**Interfaces:**
- Consumes: `crate::vault::kind::{Kind, resolve}` and current `PageMeta.kind`.
- Produces: private `validate_kind_assignment(path: &VaultPath, declared_kind: Option<Kind>, requested_kind: Kind) -> Result<(), ApiError>` used by both assignment paths.

- [ ] **Step 1: Write failing single-assignment tests**

Add tests using the existing API fixture helpers for these observable contracts:

```rust
#[tokio::test]
async fn journal_kind_assignment_rejects_reclassification_but_allows_other_metadata() {
    // Seed journals/daily.md with `type: JOURNAL`.
    // POST pages-assign/journals/daily.md with {"kind":"NOTE"}; assert 400,
    // error contains "journal kind cannot be changed", source bytes unchanged,
    // and notes/daily.md does not exist.
    // POST the same source with {"kind":"JOURNAL"}; assert 200.
    // POST the returned path with {"project":"personal"}; assert 200 and
    // response kind remains JOURNAL.
}

#[tokio::test]
async fn inferred_journal_kind_assignment_rejects_reclassification() {
    // Seed journals/inferred.md without `type`.
    // POST {"kind":"NOTE"}; assert 400 and source bytes unchanged.
}

#[tokio::test]
async fn non_journal_can_be_assigned_to_journal() {
    // Seed notes/log.md as NOTE.
    // POST {"kind":"JOURNAL"}; assert 200, kind JOURNAL, and journals/log.md.
}
```

- [ ] **Step 2: Run single-assignment tests and verify RED**

Run the exact new tests with:

```bash
cargo test --test api_test journal_kind_assignment -- --nocapture
cargo test --test api_test inferred_journal_kind_assignment -- --nocapture
cargo test --test api_test non_journal_can_be_assigned_to_journal -- --nocapture
```

Expected: the two rejection tests fail because assignment currently returns 200; the assignment-into-Journal test passes and records the retained contract.

- [ ] **Step 3: Write failing atomic bulk test**

```rust
#[tokio::test]
async fn bulk_kind_assignment_rejects_journal_reclassification_atomically() {
    // Seed notes/ordinary.md as NOTE and journals/daily.md as JOURNAL.
    // Save both byte vectors.
    // POST pages-assign-bulk with both paths and {"kind":"QUOTE"}.
    // Assert 400, error contains "journal kind cannot be changed",
    // both sources remain byte-identical, and neither quotes destination exists.
}
```

- [ ] **Step 4: Run bulk test and verify RED**

Run:

```bash
cargo test --test api_test bulk_kind_assignment_rejects_journal_reclassification_atomically -- --nocapture
```

Expected: FAIL because both pages are currently reclassified.

- [ ] **Step 5: Implement the shared validation helper**

Import `Kind` and `resolve`, then add a private helper near the assignment handlers:

```rust
fn validate_kind_assignment(
    path: &VaultPath,
    declared_kind: Option<Kind>,
    requested_kind: Kind,
) -> Result<(), ApiError> {
    let (current_kind, _) = crate::vault::kind::resolve(path.as_str(), declared_kind);
    if current_kind == Kind::Journal && requested_kind != Kind::Journal {
        return Err(ApiError::bad_request("journal kind cannot be changed"));
    }
    Ok(())
}
```

Use actual enum variant spelling from `src/vault/kind.rs` if it differs.

In `assign_page`, after parsing `body.kind` and before mutating `page.meta.kind`, call:

```rust
validate_kind_assignment(&vp, page.meta.kind, parsed)?;
```

In `plan_bulk_assignment`, after each page is read and before `meta.kind` is replaced, call the same helper when `assigned_kind` is `Some`:

```rust
if let Some(kind) = assigned_kind {
    validate_kind_assignment(&path, meta.kind, kind)?;
    meta.kind = Some(kind);
}
```

Do not validate project-only requests.

- [ ] **Step 6: Run focused backend tests and verify GREEN**

Run:

```bash
cargo test --test api_test journal_kind_assignment -- --nocapture
cargo test --test api_test inferred_journal_kind_assignment -- --nocapture
cargo test --test api_test non_journal_can_be_assigned_to_journal -- --nocapture
cargo test --test api_test bulk_kind_assignment_rejects_journal_reclassification_atomically -- --nocapture
```

Expected: all new tests pass.

- [ ] **Step 7: Run adjacent assignment tests**

Run:

```bash
cargo test --test api_test recipe_kind_create_filter_and_assign -- --nocapture
cargo test --test api_test bulk_assign -- --nocapture
cargo test --test api_test page_mutation_project_assignment -- --nocapture
```

Expected: existing assignment, bulk atomicity, and project semantics pass.

- [ ] **Step 8: Commit backend invariant**

```bash
git add src/api/pages.rs tests/api_test.rs
git commit -m "fix(api): lock journal kind assignment"
```

---

### Task 2: Render Journal Kind as Immutable in Folio

**Files:**
- Modify: `ui/src/components/codex/KindSelect.tsx:11-67`
- Modify: `ui/src/components/codex/Folio.tsx:1136-1144`
- Test: `ui/src/components/codex/KindSelect.test.tsx`
- Test: `ui/src/components/codex/__tests__/Folio.test.tsx`

**Interfaces:**
- Consumes: resolved Folio `kind: Kind` and existing `KindSelect` props.
- Produces: optional `immutableReason?: string` prop. When defined, the Select is disabled, displays `· fixed`, and exposes the reason through an accessible description.

- [ ] **Step 1: Write failing KindSelect behavior tests**

Update the test imports to include `userEvent` and `vi`. Add:

```tsx
it("renders an immutable kind without opening or assigning", async () => {
  const user = userEvent.setup();
  const onAssign = vi.fn();
  render(
    <KindSelect
      value="JOURNAL"
      inferred={false}
      immutableReason="Journal kind cannot be changed."
      onAssign={onAssign}
    />,
  );

  const trigger = screen.getByRole("button", { name: "Kind" });
  expect(trigger).toBeDisabled();
  expect(trigger).toHaveTextContent("JOURNAL");
  expect(trigger).toHaveTextContent("fixed");
  expect(trigger).toHaveAccessibleDescription(
    "Journal kind cannot be changed.",
  );
  await user.click(trigger);
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(onAssign).not.toHaveBeenCalled();
});

it("keeps ordinary kinds assignable", async () => {
  const user = userEvent.setup();
  const onAssign = vi.fn();
  render(<KindSelect value="NOTE" inferred={false} onAssign={onAssign} />);
  await user.click(screen.getByRole("button", { name: "Kind" }));
  await user.click(screen.getByRole("option", { name: "QUOTE" }));
  expect(onAssign).toHaveBeenCalledWith("QUOTE");
});
```

- [ ] **Step 2: Run KindSelect tests and verify RED**

Run:

```bash
bun run test -- src/components/codex/KindSelect.test.tsx
```

Expected: TypeScript/runtime failure because `immutableReason` is not implemented.

- [ ] **Step 3: Implement disabled KindSelect semantics**

Add `immutableReason?: string` to `KindSelectProps`, receive it in the component, and wire:

```tsx
<Select
  aria-label={ariaLabel ?? "Kind"}
  aria-describedby={ariaDescribedBy}
  isDisabled={immutableReason !== undefined}
  selectedKey={value}
  onSelectionChange={(k) => onAssign(k as Kind)}
>
```

Give the trigger a native/accessibility description accepted by React Aria (`aria-description={immutableReason}` if supported by the current types; otherwise render a stable visually-hidden description ID and merge it with `ariaDescribedBy`). Add disabled cursor/color styles and render this beside the label:

```tsx
{immutableReason !== undefined && (
  <span className="text-[9px] tracking-[0.12em] text-ink-mute">
    · fixed
  </span>
)}
```

Do not render `· inferred` and `· fixed` simultaneously for the Folio Journal case.

- [ ] **Step 4: Run KindSelect tests and verify GREEN**

Run:

```bash
bun run test -- src/components/codex/KindSelect.test.tsx
```

Expected: all KindSelect tests pass.

- [ ] **Step 5: Write failing Folio integration test**

In `Folio.test.tsx`, return an editable editor with `kind: "JOURNAL"`, render the Folio, and assert:

```tsx
const kind = screen.getByRole("button", { name: "Kind" });
expect(kind).toBeDisabled();
expect(kind).toHaveTextContent("JOURNAL");
expect(kind).toHaveTextContent("fixed");
expect(kind).toHaveAccessibleDescription("Journal kind cannot be changed.");
```

This test must exercise `Folio` rather than rendering `KindSelect` directly.

- [ ] **Step 6: Run Folio test and verify RED**

Run:

```bash
bun run test -- src/components/codex/__tests__/Folio.test.tsx
```

Expected: the new assertion fails because Folio does not pass immutable state.

- [ ] **Step 7: Wire the resolved Journal invariant into Folio**

Change the existing `KindSelect` call to include:

```tsx
immutableReason={
  kind === "JOURNAL" ? "Journal kind cannot be changed." : undefined
}
```

Use the resolved `kind`, not `editor.inferred`, path prefix, or computed tag.

- [ ] **Step 8: Run focused UI tests and typecheck**

Run:

```bash
bun run test -- src/components/codex/KindSelect.test.tsx src/components/codex/__tests__/Folio.test.tsx
bun run typecheck
```

Expected: focused tests and TypeScript pass.

- [ ] **Step 9: Commit Folio affordance**

```bash
git add ui/src/components/codex/KindSelect.tsx ui/src/components/codex/KindSelect.test.tsx ui/src/components/codex/Folio.tsx ui/src/components/codex/__tests__/Folio.test.tsx
git commit -m "fix(ui): render journal kind as fixed"
```

---

### Task 3: Verify the Integrated Contract

**Files:**
- Modify only if a verification failure identifies a feature-owned defect.

**Interfaces:**
- Consumes: backend assignment invariant and Folio immutable control from Tasks 1-2.
- Produces: verified feature branch ready for review and merge.

- [ ] **Step 1: Run focused contract suites**

```bash
cargo test --test api_test journal_kind_assignment -- --nocapture
cargo test --test api_test inferred_journal_kind_assignment -- --nocapture
cargo test --test api_test non_journal_can_be_assigned_to_journal -- --nocapture
cargo test --test api_test bulk_kind_assignment_rejects_journal_reclassification_atomically -- --nocapture
bun --cwd ui run test -- src/components/codex/KindSelect.test.tsx src/components/codex/__tests__/Folio.test.tsx
```

Expected: all focused contracts pass.

- [ ] **Step 2: Run repository gates**

```bash
cargo test
bun --cwd ui run typecheck
bun --cwd ui run lint
bun --cwd ui run test
bun --cwd ui run build
```

Expected: every command exits 0. Report pre-existing warnings separately; do not suppress them.

- [ ] **Step 3: Smoke the real API and Folio surface**

Start `clep serve` against a temporary vault. Create a Journal page, verify `POST /api/vault/pages-assign/{path}` with `{"kind":"NOTE"}` returns 400 and leaves the page unchanged, then open the page in the browser and verify the Kind control reads `JOURNAL · fixed`, is disabled, and exposes the immutable explanation.

- [ ] **Step 4: Commit only necessary verification fixes**

If Step 1-3 required feature-owned corrections, commit only those exact files with a message describing the corrected contract. If no correction was required, do not create an empty commit.
