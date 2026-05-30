# GAZETTEER Multi-Tag Filter Implementation Plan (WU-6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the GAZETTEER all-notes table from single-tag filtering to **multi-select tag filtering with AND semantics**, seeded by the `?tag=` search param, while keeping the existing kind pip, grep, and sort.

**Architecture:** Extract the table's filter+sort logic out of the inline `rows` memo into a pure, unit-tested module (`gazetteer-filter.ts`), then refactor `Gazetteer.tsx` to hold a list of selected tags (instead of a single nullable tag), toggle chips into/out of that list, and apply AND filtering through the new helper.

**Tech Stack:** React 19, TanStack Router (file-based route with a `tag` search param), Vitest, Biome, Tailwind v4.

**Source spec:** `docs/superpowers/specs/2026-05-29-vessel-drift-closure-design.md` → **WU-6**.

## Scope notes (verified against current code)

- `ui/src/components/codex/Gazetteer.tsx` **already** renders a per-row **kind pip** (in the File-ID cell, via `kindColorVar(resolveKindFromPath(path))` + `kindLabel` title) — so WU-6's "kind pip" requirement is **already satisfied**; this plan does not change it (a verification step confirms it stays).
- The current tag rail is **single-select**: state is `tag: string | null`; clicking a chip sets that one tag, clicking again clears. This plan makes it **multi-select / AND**.
- The route `ui/src/routes/gazetteer.tsx` validates a single `?tag=` string and passes it as `initialTag`. We keep that contract (single tag in the URL **seeds** the selection); multi-tag selection happens in-component. The spec only requires "remaining compatible with arriving via the `?tag=` search param" — not multi-tag URLs. Do **not** change the route.
- `useContentIndex(500)` items are `ContentEntry { path, title?, description, tags[], links[], created_at?, updated_at?, word_count? }`. `useTags()` returns `TagCount[] { tag, count }`.

## ⚠️ Concurrent-WIP git rule (applies to every task)

The working tree contains the user's unrelated in-flight WIP in many files. Touch ONLY the files named in each task and stage ONLY those exact paths (e.g. `git add ui/src/components/codex/gazetteer-filter.ts ui/src/components/codex/gazetteer-filter.test.ts`). NEVER `git add -A`/`.`/`ui/`. `Gazetteer.tsx`, the route, and the new helper are NOT in the user's WIP, so they're safe to edit — but other files (Folio, Sheaf, editor, schema.d.ts) must not be touched or staged.

Run all `bun` commands from `ui/`. Baseline `bun run typecheck` / `bun run lint` are CLEAN; `bun run build`/`typecheck` compile the whole tree (incl. the user's WIP) which currently passes — so any new error referencing your files is yours, and errors referencing other files are pre-existing WIP (do not touch).

---

## File structure

**Create:**
- `ui/src/components/codex/gazetteer-filter.ts` — pure `filterAndSortRows(items, { tags, query, sort })` + exported `GazetteerSort` type and row interface.
- `ui/src/components/codex/gazetteer-filter.test.ts` — unit tests for the helper.

**Modify:**
- `ui/src/components/codex/Gazetteer.tsx` — multi-tag state, chip toggles, header/empty-state copy; delegate filtering to the helper.

---

## Task 1: Pure filter+sort helper (`gazetteer-filter.ts`)

Extracts the existing inline filter/sort logic into a testable function and adds the **AND** multi-tag behavior.

**Files:**
- Create: `ui/src/components/codex/gazetteer-filter.ts`
- Test: `ui/src/components/codex/gazetteer-filter.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/components/codex/gazetteer-filter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { filterAndSortRows, type GazetteerRow } from "./gazetteer-filter";

const items: GazetteerRow[] = [
  { path: "a.md", title: "Alpha", description: "first note", tags: ["x", "y"], updated_at: "2026-05-03T00:00:00Z", word_count: 100 },
  { path: "b.md", title: "Beta", description: "second", tags: ["x"], updated_at: "2026-05-01T00:00:00Z", word_count: 300 },
  { path: "c.md", title: "Gamma", description: "third note", tags: ["y"], updated_at: "2026-05-02T00:00:00Z", word_count: 200 },
];

describe("filterAndSortRows", () => {
  it("returns all items sorted by updated_at desc when no filters", () => {
    const out = filterAndSortRows(items, { tags: [], query: "", sort: "ts" });
    expect(out.map((r) => r.path)).toEqual(["a.md", "c.md", "b.md"]);
  });

  it("filters by a single tag", () => {
    const out = filterAndSortRows(items, { tags: ["y"], query: "", sort: "ts" });
    expect(out.map((r) => r.path).sort()).toEqual(["a.md", "c.md"]);
  });

  it("AND-filters across multiple tags (row must include ALL selected)", () => {
    const out = filterAndSortRows(items, { tags: ["x", "y"], query: "", sort: "ts" });
    expect(out.map((r) => r.path)).toEqual(["a.md"]);
  });

  it("returns empty when no row has all selected tags", () => {
    const out = filterAndSortRows(items, { tags: ["x", "z"], query: "", sort: "ts" });
    expect(out).toEqual([]);
  });

  it("greps title, path, description and tags (case-insensitive)", () => {
    expect(filterAndSortRows(items, { tags: [], query: "third", sort: "ts" }).map((r) => r.path)).toEqual(["c.md"]);
    expect(filterAndSortRows(items, { tags: [], query: "BETA", sort: "ts" }).map((r) => r.path)).toEqual(["b.md"]);
    expect(filterAndSortRows(items, { tags: [], query: "#y", sort: "ts" }).length).toBe(0); // query is plain text, tags joined without '#'
    expect(filterAndSortRows(items, { tags: [], query: "y", sort: "ts" }).length).toBe(2); // matches tag "y" via joined tags
  });

  it("combines AND tags with grep", () => {
    const out = filterAndSortRows(items, { tags: ["x"], query: "first", sort: "ts" });
    expect(out.map((r) => r.path)).toEqual(["a.md"]);
  });

  it("sorts by words desc, title asc, and id (path) asc", () => {
    expect(filterAndSortRows(items, { tags: [], query: "", sort: "words" }).map((r) => r.path)).toEqual(["b.md", "c.md", "a.md"]);
    expect(filterAndSortRows(items, { tags: [], query: "", sort: "title" }).map((r) => r.title)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(filterAndSortRows(items, { tags: [], query: "", sort: "id" }).map((r) => r.path)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("does not mutate the input array", () => {
    const snapshot = items.map((r) => r.path);
    filterAndSortRows(items, { tags: [], query: "", sort: "words" });
    expect(items.map((r) => r.path)).toEqual(snapshot);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bun run test src/components/codex/gazetteer-filter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `gazetteer-filter.ts`**

Create `ui/src/components/codex/gazetteer-filter.ts`:

```ts
// Pure filtering + sorting for the GAZETTEER table. No React, no I/O — testable.

export type GazetteerSort = "ts" | "id" | "title" | "words";

export interface GazetteerRow {
  path: string;
  title?: string | null;
  description?: string | null;
  tags?: string[] | null;
  updated_at?: string | null;
  word_count?: number | null;
}

export interface GazetteerFilter {
  /** All selected tags must be present on a row (AND semantics). */
  tags: string[];
  /** Case-insensitive substring grep over title/path/description/tags. */
  query: string;
  sort: GazetteerSort;
}

export function filterAndSortRows<T extends GazetteerRow>(
  items: T[],
  { tags, query, sort }: GazetteerFilter,
): T[] {
  const q = query.trim().toLowerCase();

  let out = items;
  if (tags.length > 0) {
    out = out.filter((n) => {
      const rowTags = n.tags ?? [];
      return tags.every((t) => rowTags.includes(t));
    });
  }
  if (q) {
    out = out.filter((n) =>
      `${n.title ?? ""} ${n.path} ${n.description ?? ""} ${(n.tags ?? []).join(" ")}`
        .toLowerCase()
        .includes(q),
    );
  }

  const sorted = [...out];
  sorted.sort((a, b) => {
    if (sort === "ts") {
      return (
        (b.updated_at ? Date.parse(b.updated_at) : 0) -
        (a.updated_at ? Date.parse(a.updated_at) : 0)
      );
    }
    if (sort === "words") {
      return (b.word_count ?? 0) - (a.word_count ?? 0);
    }
    if (sort === "title") {
      return (a.title ?? a.path).localeCompare(b.title ?? b.path);
    }
    return a.path.localeCompare(b.path);
  });
  return sorted;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bun run test src/components/codex/gazetteer-filter.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck**

Run: `cd ui && bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit (stage ONLY the two new files)**

```bash
git add ui/src/components/codex/gazetteer-filter.ts ui/src/components/codex/gazetteer-filter.test.ts
git commit -m "feat(gazetteer): pure filter+sort helper with AND multi-tag semantics"
```

---

## Task 2: Multi-tag selection in `Gazetteer.tsx`

Replace the single-tag state with a tag list, toggle chips into/out of it, AND-filter via the helper, and update the header/empty-state copy. The kind pip and table markup are unchanged.

**Files:**
- Modify: `ui/src/components/codex/Gazetteer.tsx`

- [ ] **Step 1: Swap state + imports**

In `ui/src/components/codex/Gazetteer.tsx`:

Change the import line:
```tsx
import { useMemo, useState } from "react";
```
(stays the same — `useMemo`/`useState` are already imported.)

Add the helper import (place after the existing `#/lib/kind` import, matching Biome ordering — relative imports come after `#/` imports):
```tsx
import {
  filterAndSortRows,
  type GazetteerSort,
} from "./gazetteer-filter";
```

Delete the local `type Sort = "ts" | "id" | "title" | "words";` line (replaced by the imported `GazetteerSort`).

Replace the state declarations. Find:
```tsx
  const [tag, setTag] = useState<string | null>(initialTag ?? null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("ts");
```
with:
```tsx
  const [selectedTags, setSelectedTags] = useState<string[]>(
    initialTag ? [initialTag] : [],
  );
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<GazetteerSort>("ts");

  const toggleTag = (t: string) =>
    setSelectedTags((cur) =>
      cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t],
    );
```

- [ ] **Step 2: Delegate filtering to the helper**

Replace the entire `rows` memo:
```tsx
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = items;
    if (tag) out = out.filter((n) => (n.tags ?? []).includes(tag));
    if (q) {
      out = out.filter((n) =>
        `${n.title ?? ""} ${n.path} ${n.description ?? ""} ${(n.tags ?? []).join(" ")}`
          .toLowerCase()
          .includes(q),
      );
    }
    const sorted = [...out];
    sorted.sort((a, b) => {
      if (sort === "ts")
        return (
          (b.updated_at ? Date.parse(b.updated_at) : 0) -
          (a.updated_at ? Date.parse(a.updated_at) : 0)
        );
      if (sort === "words") return (b.word_count ?? 0) - (a.word_count ?? 0);
      if (sort === "title")
        return (a.title ?? a.path).localeCompare(b.title ?? b.path);
      return a.path.localeCompare(b.path);
    });
    return sorted;
  }, [items, tag, query, sort]);
```
with:
```tsx
  const rows = useMemo(
    () => filterAndSortRows(items, { tags: selectedTags, query, sort }),
    [items, selectedTags, query, sort],
  );

  const tagSummary =
    selectedTags.length > 0
      ? ` · ${selectedTags.map((t) => `#${t}`).join(" ")}`
      : "";
```

- [ ] **Step 3: Update the header count**

Find:
```tsx
        <span className="cl-mono text-[10px] uppercase tracking-[0.16em] text-ink-mute">
          {rows.length} entries{tag ? ` · #${tag}` : ""}
        </span>
```
replace with:
```tsx
        <span className="cl-mono text-[10px] uppercase tracking-[0.16em] text-ink-mute">
          {rows.length} entries{tagSummary}
        </span>
```

- [ ] **Step 4: Update the tag rail chips for multi-select**

Find the tag-rail block:
```tsx
      {/* tag rail */}
      <div className="cl-noscroll flex flex-shrink-0 flex-wrap gap-x-2 gap-y-1.5 border-b border-rule-soft px-5 py-2">
        <Chip active={tag === null} onClick={() => setTag(null)}>
          all · {items.length}
        </Chip>
        {tags.map((t) => (
          <Chip
            key={t.tag}
            active={tag === t.tag}
            onClick={() => setTag(tag === t.tag ? null : t.tag)}
          >
            #{t.tag}
            <sup className="ml-[2px] text-ink-mute">{t.count}</sup>
          </Chip>
        ))}
      </div>
```
replace with:
```tsx
      {/* tag rail — multi-select, AND semantics */}
      <div className="cl-noscroll flex flex-shrink-0 flex-wrap gap-x-2 gap-y-1.5 border-b border-rule-soft px-5 py-2">
        <Chip active={selectedTags.length === 0} onClick={() => setSelectedTags([])}>
          all · {items.length}
        </Chip>
        {tags.map((t) => (
          <Chip
            key={t.tag}
            active={selectedTags.includes(t.tag)}
            onClick={() => toggleTag(t.tag)}
          >
            #{t.tag}
            <sup className="ml-[2px] text-ink-mute">{t.count}</sup>
          </Chip>
        ))}
      </div>
```

- [ ] **Step 5: Update the empty-state copy**

Find:
```tsx
                <td colSpan={6} className="cl-marg px-3 py-6 text-center">
                  ∅ no folios{tag ? ` under #${tag}` : ""}
                  {query ? ` matching “${query}”` : ""}.
                </td>
```
replace with:
```tsx
                <td colSpan={6} className="cl-marg px-3 py-6 text-center">
                  ∅ no folios{selectedTags.length > 0 ? ` under ${selectedTags.map((t) => `#${t}`).join(" ")}` : ""}
                  {query ? ` matching “${query}”` : ""}.
                </td>
```

- [ ] **Step 6: Confirm no leftover `tag`/`setTag`/`Sort` references**

Run: `cd ui && grep -nE "\bsetTag\b|\btag ===|local Sort\b|: Sort\b|<Sort>" src/components/codex/Gazetteer.tsx || echo "clean"`
Expected: no matches referencing the removed `tag`/`setTag` state or the local `Sort` type. (The `tags` data variable and `t.tag` chip fields are fine — those are the tag-list data, not the removed state.)

- [ ] **Step 7: Typecheck, lint, build**

Run: `cd ui && bun run typecheck && bun run lint && bun run build`
Expected: all pass; no unused-symbol errors. Errors referencing OTHER files are the user's WIP — do not touch.

- [ ] **Step 8: Commit (stage ONLY Gazetteer.tsx)**

```bash
git add ui/src/components/codex/Gazetteer.tsx
git commit -m "feat(gazetteer): multi-select AND tag filtering via chips"
```

---

## Task 3: Verification

**Files:** none (verification only).

- [ ] **Step 1: Full gate**

Run: `cd ui && bun run typecheck && bun run lint && bun run test && bun run build`
Expected: all green. Record the test count (the new `gazetteer-filter.test.ts` adds 8 tests).

- [ ] **Step 2: Confirm the kind pip is intact**

Run: `cd ui && grep -n "kindColorVar(kind)\|kindLabel(kind)\|resolveKindFromPath" src/components/codex/Gazetteer.tsx`
Expected: the File-ID cell still renders the kind pip (`kindColorVar`/`kindLabel`) — WU-6's kind-pip requirement remains satisfied.

- [ ] **Step 3: Manual smoke (dev server)**

Run `cd ui && bun run dev`, open `/gazetteer`, and confirm:
- Clicking multiple tag chips keeps them all active and narrows the table to rows containing **all** selected tags (AND).
- The header shows `N entries · #a #b` for the selected tags.
- Clicking an active chip removes just that tag; clicking **all** clears the selection.
- Arriving via a tag link from ATRIUM (`/gazetteer?tag=foo`) starts with `#foo` selected.
- Each row still shows its colored kind pip; grep and the ts/id/title/words sort still work.

- [ ] **Step 4: Stop the dev server** (Ctrl-C).

---

## Self-review (coverage map)

| WU-6 requirement | Task |
|---|---|
| Per-row kind pip (`resolveKindFromPath`/`kindColorVar`) | Already present — verified in Task 3 Step 2 |
| Tag-filter rail, **multi-select AND**, replacing single-`initialTag` | Tasks 1–2 |
| Compatible with arriving via `?tag=` search param | Task 2 Step 1 (seeds `selectedTags` from `initialTag`); route unchanged |
| Grep + sort preserved | Task 1 (helper) + Task 2 (delegation) |
