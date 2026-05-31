# Orphan / Isolated Page Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two real, correctly-defined corpus metrics — **orphan pages** (zero inbound links) and **isolated pages** (no links in or out) — alongside the existing `links_unresolved` (broken links), and surface them, without ever conflating the three.

**Architecture:** Two additional `COUNT` queries in the `stats` handler over `pages`/`links`; two new fields on `VaultStats`; frontend displays them. Independent of all other plans.

**Tech Stack:** Rust 2024, rusqlite, Axum, utoipa; React/TypeScript frontend.

**Reference docs:** `CONTEXT.md` (Orphan, Unresolved link, Isolated page).

**Depends on:** nothing.

---

## File Structure

- `src/api/index_routes.rs` — **modify.** `VaultStats` (~:94) gains `orphan_pages`, `isolated_pages`; the `stats` handler (~:510) computes them.
- `ui/src/components/codex/atrium-data.ts` — **modify.** Add the fields to the stats type; expose as inventory cells.
- `ui/src/components/codex/Ticker.tsx` / `ui/src/components/SettingsModal.tsx` — **modify.** Add cells/rows; confirm "unresolved" stays labelled unresolved (already correct).

---

## Task 1: Backend counts on `VaultStats`

**Files:**
- Modify: `src/api/index_routes.rs`
- Test: inline `#[cfg(test)]` (or the existing stats test)

- [ ] **Step 1: Write the failing test**

Build a small in-memory index with a known shape and assert the counts. Mirror the existing stats/index test setup:

```rust
#[tokio::test]
async fn stats_counts_orphan_and_isolated_pages() {
    // Pages: A links to B. C links to nothing and nothing links to C.
    //   A: outbound only        -> not orphan (no... A has 0 inbound) -> A IS orphan, NOT isolated (has outbound)
    //   B: inbound only          -> not orphan, not isolated
    //   C: no links either way   -> orphan AND isolated
    let state = test_state_with_linked_pages().await; // helper builds A->B, plus C
    let stats = stats(State(state)).await.unwrap().0;
    assert_eq!(stats.orphan_pages, 2);   // A and C (nothing links to them)
    assert_eq!(stats.isolated_pages, 1); // C only
}
```

> `test_state_with_linked_pages` stands for a helper that indexes three pages with the described link structure. Match the existing stats-test helper; adjust the asserted numbers to the exact fixture you build (the *definitions* are what matter: orphan = 0 inbound; isolated = 0 inbound AND 0 outbound).

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --lib api::index_routes` (or the stats test path)
Expected: FAIL — `orphan_pages`/`isolated_pages` absent.

- [ ] **Step 3: Add the fields**

In `VaultStats` (`index_routes.rs:94`), after `links_unresolved`:

```rust
    /// Pages with zero inbound links (the canonical "orphan").
    orphan_pages: i64,
    /// Pages with no links inbound or outbound.
    isolated_pages: i64,
```

- [ ] **Step 4: Compute them in the handler**

In the `with_index` closure of `stats` (`index_routes.rs:524`), add two queries alongside the existing ones:

```rust
let orphan_pages: i64 = conn.query_row(
    "SELECT COUNT(*) FROM pages p
      WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.target_id = p.id)",
    [], |row| row.get(0),
)?;

let isolated_pages: i64 = conn.query_row(
    "SELECT COUNT(*) FROM pages p
      WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.target_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM links l WHERE l.source_id = p.id)",
    [], |row| row.get(0),
)?;
```

Add `orphan_pages` and `isolated_pages` to the returned tuple and to the final `VaultStats { .. }` construction.

> Confirm the links table columns are `target_id` / `source_id` (they are — `index.rs` schema). The tuple returned by the closure must be widened to carry the two new values; update both the tuple type and the destructuring at the call site.

- [ ] **Step 5: Run to verify it passes**

Run: `cargo test --lib api::index_routes`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/api/index_routes.rs
git commit -m "feat(api): orphan_pages + isolated_pages on VaultStats"
```

---

## Task 2: Surface the counts in the frontend

**Files:**
- Modify: `ui/src/components/codex/atrium-data.ts`, `ui/src/components/codex/Ticker.tsx`, `ui/src/components/SettingsModal.tsx`
- Test: `ui/src/components/codex/atrium-data.test.ts` (extend)

- [ ] **Step 1: Write/extend the failing test**

In `ui/src/components/codex/atrium-data.test.ts`, add the new fields to the mock stats and assert they flow into whatever inventory/derivation function the file exports (mirror the existing `links_unresolved` assertions at lines referencing it):

```ts
// in the existing stats mock:
orphan_pages: 4,
isolated_pages: 1,
// then assert the derived inventory includes an "orphans" entry = 4
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && bun run test atrium-data`
Expected: FAIL (field missing on type / not surfaced).

- [ ] **Step 3: Add fields to the stats type + derivation**

In `atrium-data.ts`, add to the stats type (near `links_unresolved: number;` at :38):

```ts
  orphan_pages: number;
  isolated_pages: number;
```

Add an inventory cell for orphans (and optionally isolated), mirroring the existing `links_unresolved` cell (~:195). Label it **"orphans"** (pages, not links) — keep `links_unresolved` labelled **"unresolved"**. Do not relabel the existing unresolved cell.

- [ ] **Step 4: Add cells/rows in Ticker + SettingsModal**

- `Ticker.tsx`: after the `unresolved` cell (:81), add `<Cell label="orphans" value={stats?.orphan_pages ?? "—"} />`.
- `SettingsModal.tsx`: after the "Links, unresolved" row (:230), add `["Pages, orphaned", stats?.orphan_pages ?? "—"]` and `["Pages, isolated", stats?.isolated_pages ?? "—"]`.

> Regenerate the API types so `useStats()` carries the new fields (the schema-gen step). The labels must keep "unresolved" = links and introduce "orphans"/"isolated" = pages — never call unresolved links "orphans".

- [ ] **Step 5: Verify + commit**

Run: `cd ui && bun run test atrium-data && bun run typecheck && bun run lint`
Expected: all pass.

```bash
git add ui/src/components/codex/atrium-data.ts ui/src/components/codex/atrium-data.test.ts ui/src/components/codex/Ticker.tsx ui/src/components/SettingsModal.tsx
git commit -m "feat(ui): surface orphan/isolated page counts; keep unresolved labelled as links"
```

---

## Final verification

- [ ] `cargo test` + `cd ui && bun run typecheck && bun run test` — all pass.
- [ ] Manual: `GET /api/vault/index/stats` returns `links_unresolved`, `orphan_pages`, `isolated_pages` as three distinct numbers; ATRIUM/Ticker/Settings show them with correct labels (unresolved = links; orphans/isolated = pages).

---

## Notes for the executor

- The three metrics are **not interchangeable**: `links_unresolved` counts *link rows*; `orphan_pages` and `isolated_pages` count *pages*. Never wire one to a label meant for another.
- CONSTELLATION's client-side `orphansVisible` filter (isolated-node sense) is separate and untouched here; optionally point it at the new `isolated_pages` notion later, but it is not part of this plan.
