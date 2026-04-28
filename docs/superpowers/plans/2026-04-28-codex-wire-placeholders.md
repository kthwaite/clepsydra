# Codex UI — Wire Placeholders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace decorative placeholders in the Codex frontend (Atrium / Diurnal / Folio / Constellation / Gazetteer / CodexFrame / CommandPalette) with real, data-driven equivalents — or, where the underlying data does not yet exist, either add the small backend nudge required to expose it, defer with a documented rationale, or knowingly preserve the element as decorative.

**Architecture:** Three waves. Wave 1 is pure-frontend wiring against existing API surface. Wave 2 adds three small backend additions (`last_indexed_at`, `similar`, body word count) plus the matching React Query hooks. Wave 3 is net-new interactive features (Inscribe modal, Constellation filters, Marginalia from body footnotes). Items requiring entirely new domain models (Habits, Reading, Inquiry, Horologe sun) are deferred with a written rationale.

**Tech Stack:** React 19 · TanStack Router/Query · Zustand · openapi-react-query · Slate.js · Vitest (component logic) · Axum 0.8 · rusqlite · pulldown-cmark · utoipa.

**Conventions enforced by this plan:**
- Frontend pure-logic helpers (TOC builder, footnote extractor, similar-pages tag-overlap fallback, hub/orphan derivation) get unit tests with Vitest. Component wiring gets `bun run typecheck` + `bun run lint` + manual smoke. The codebase has no JSDOM/render testing for codex components today and we are not adding it in this plan.
- Backend additions get Rust integration tests against a temporary vault, mirroring the style in `src/api/index_routes.rs` callers.
- Each task ends with a commit. Commit messages use the conventional-commit prefix already in this repo (`feat`, `fix`, `refactor`, `perf`, etc.) and namespace the scope (`feat(ui-codex): …`, `feat(api-index): …`).

---

## Scope: Element-by-Element Decision Table

| Element | Wave | Decision |
|---|---|---|
| Top bar `vol. iv · clean` (volume, clean/dirty) | 1 | Replace `vol. iv` with computed volume from year (`vol. ${roman((year - 2023))}`) — purely deterministic; drop `clean` (workspace store has no per-tab dirty flag and adding one is out of scope) |
| Top bar `PL. I/XII/V/∞` plate codes | — | Decorative. Keep. Plate code per-view is intentional typography. |
| Top bar `fol. {code}` | — | Already wired (deterministic hash). Keep. |
| Bottom bar `READ` | — | Decorative banner. Keep. |
| Bottom bar `UTF-8` | — | Decorative. Keep. |
| Bottom bar `idx ✓` | 1 | Replace with real value — true iff `useStats()` query has `data` and not `error`. |
| Bottom bar `agent · idle` | 1 | Drop. No agent system exists. |
| Bottom bar `last collated {clock} GMT` | 2 | Backend: add `last_indexed_at` to `VaultStats`. Frontend: render relative time. |
| Atrium frontispiece copy | — | Decorative narrator voice. Keep. |
| Atrium "Reading Continues" panel | 3 (deferred) | Books model not in scope. Stub as feature spec, hide panel behind `import.meta.env.VITE_ENABLE_READING_PANEL`. |
| Atrium "Inquiry, open" list | 3 (deferred) | Inquiry model not in scope. Stub similarly behind a flag. |
| Atrium horologe sunset/light remaining | 3 (deferred) | Astronomical lib + lat/lon settings out of scope. Replace remaining-text with a literal honest "no location set" until then. |
| Atrium "Privatim · Lectori Suo" stamp | — | Decorative. Keep. |
| Atrium ASCII compass + fig. iii caption | — | Decorative. Keep. |
| Atrium "+ Inscribe" button | 3 | Wire to a new-page modal using `useCreatePage` |
| Atrium `vii of …` Recently-Inscribed sub-count | 1 | Replace with `${roman(min(recent.length, totalEntries))} of ${roman(totalEntries)}` |
| Diurnal "Habits, this day" rail | 3 (deferred) | Habits model out of scope. Replace block with marginalia placeholder noting future. |
| Diurnal "Et cetera" prose | — | Decorative. Keep. |
| Diurnal ASCII quill + fig. iv | — | Decorative. Keep. |
| Diurnal `MMXXVI · day {N}` | 1 | Compute year roman from selected date. |
| Folio `READ · IV·xxviii` rotated stamp | — | Decorative. Keep. |
| Folio metadata `drafted / last touched` | 2 | Plumb `meta.created_at` / `meta.updated_at` from `usePage` through `usePageEditor` and render as relative dates. |
| Folio metadata `certainty / importance` | 2 | Read from `meta` if present, else show "—". (Schema already permits unknown fields after `created_at/updated_at`.) Optional micro-extension to `PageMetaResponse` to pass these through if frontmatter has them. |
| Folio metadata `{wordCount}` | 1 | Compute from current Slate value, not from `title + tags`. |
| Folio triplet `↘ backlinks · N` | — | Already real. |
| Folio triplet `≈ similar · N` | 2 | Backend: add `/api/vault/index/similar/{path}`. Frontend: hook + count. |
| Folio triplet `⌥ bibliography · N` | 2 | Backend route already exists (`/index/outlinks/{path}`); add a React Query hook + count. |
| Folio Marginalia rail | 3 | Replace static instructional text with extracted footnote definitions from current Slate value. |
| Folio `cont. on V·iv` continuation hint | — | Was decorative-only and is not present in current Folio.tsx. No-op. |
| Constellation `fig. v · N nodes · N vertices` | — | Already real. |
| Constellation registration corners + plate label + N↑ scale | — | Decorative. Keep. |
| Constellation Filters rail (subjects/depth/orphans/daily/time-window) | 3 | Make functional: orphan toggle, daily-node hide (any path matching `journal/`), depth-from-active. |
| Constellation "Suggested Connexion" | — | Not present. No-op. |
| Gazetteer `IV · MMXXVI` strap | 1 | Compute from current month/year. |
| Gazetteer per-card word-count badge | 2 | Backend: extend `ContentEntry` with optional `word_count`. Frontend: display when present. |
| CommandPalette `console.clepsydra · v0.4.1` | 1 | Wire to `import.meta.env.PACKAGE_VERSION` exposed via Vite `define`. |

Anything not listed above is decorative on purpose and stays.

---

## File Structure

### New files
- `ui/src/api/similar.ts` — `useSimilar(path)` hook (Wave 2).
- `ui/src/api/outlinks.ts` — `useOutlinks(path)` hook (Wave 2).
- `ui/src/components/codex/InscribeModal.tsx` — modal for "+ Inscribe" (Wave 3).
- `ui/src/components/codex/footnotes.ts` — pure helpers `extractFootnoteDefinitions(value)` (Wave 3).
- `ui/src/components/codex/footnotes.test.ts` — Vitest unit tests for the helper.
- `ui/src/components/codex/constellation-filters.ts` — pure helpers `applyFilters(graph, opts)`.
- `ui/src/components/codex/constellation-filters.test.ts` — Vitest tests.

### Modified files
- `ui/src/api/index.ts` — re-export new hooks.
- `ui/src/api/types.ts` — re-export new types from generated schema.
- `ui/src/components/codex/CodexFrame.tsx` — drop `agent · idle`, wire `last collated`, replace `vol. iv · clean`, wire `idx ✓`.
- `ui/src/components/codex/Atrium.tsx` — wire `vii of …`, wire `+ Inscribe`, gate Reading/Inquiry/Horologe panels.
- `ui/src/components/codex/Diurnal.tsx` — compute year from selected date; gate habits panel.
- `ui/src/components/codex/Folio.tsx` — body word count; metadata strip from `usePage` meta; bibliography & similar counts; marginalia from footnotes.
- `ui/src/components/codex/Constellation.tsx` — functional filter rail.
- `ui/src/components/codex/Gazetteer.tsx` — strap date; per-card word count when present.
- `ui/src/components/codex/CommandPalette.tsx` — version footer from build define.
- `ui/src/editor/usePageEditor.ts` — surface `createdAt` / `updatedAt` / `bodyMarkdown` from saved data.
- `ui/vite.config.ts` — add `define` for `__APP_VERSION__`.
- `src/api/index_routes.rs` — add `last_indexed_at`, add `similar` route, extend `ContentEntry` with optional `word_count`.
- `src/api/openapi.rs` — register new types/routes.

---

## Wave 1 — Frontend-only wiring

### Task 1: Body word count from Slate value (Folio)

**Files:**
- Modify: `ui/src/components/codex/Folio.tsx:42-46`
- Modify: `ui/src/components/codex/folio-utils.ts` (add `countWordsFromSlate`)
- Test: `ui/src/components/codex/folio-utils.test.ts` (new)

- [ ] **Step 1: Write the failing test for `countWordsFromSlate`**

```ts
// ui/src/components/codex/folio-utils.test.ts
import { describe, expect, it } from "vitest";
import { countWordsFromSlate } from "./folio-utils";

describe("countWordsFromSlate", () => {
  it("returns 0 for empty value", () => {
    expect(countWordsFromSlate([])).toBe(0);
  });

  it("counts words across leaves", () => {
    const value = [
      { type: "paragraph", children: [{ text: "the kettle has " }, { text: "stopped twice" }] },
      { type: "paragraph", children: [{ text: "outside, a pigeon" }] },
    ];
    expect(countWordsFromSlate(value)).toBe(8);
  });

  it("ignores empty leaves and whitespace-only text", () => {
    const value = [
      { type: "paragraph", children: [{ text: "  " }, { text: "" }, { text: "one" }] },
    ];
    expect(countWordsFromSlate(value)).toBe(1);
  });

  it("walks heading and list-item children recursively", () => {
    const value = [
      { type: "heading", level: 1, children: [{ text: "alpha beta" }] },
      {
        type: "list",
        children: [
          {
            type: "list-item",
            children: [{ type: "paragraph", children: [{ text: "gamma delta" }] }],
          },
        ],
      },
    ];
    expect(countWordsFromSlate(value)).toBe(4);
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run: `cd ui && bun run test folio-utils -- --run`
Expected: FAIL — `countWordsFromSlate is not a function`.

- [ ] **Step 3: Implement `countWordsFromSlate` in `folio-utils.ts`**

```ts
// append to ui/src/components/codex/folio-utils.ts
type SlateLike = { text?: string; children?: SlateLike[] };

export function countWordsFromSlate(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let count = 0;
  const walk = (n: SlateLike) => {
    if (typeof n.text === "string") {
      const words = n.text.trim().split(/\s+/).filter(Boolean);
      count += words.length;
      return;
    }
    if (Array.isArray(n.children)) n.children.forEach(walk);
  };
  (value as SlateLike[]).forEach(walk);
  return count;
}
```

- [ ] **Step 4: Run test and verify it passes**

Run: `cd ui && bun run test folio-utils -- --run`
Expected: PASS.

- [ ] **Step 5: Wire it into Folio body word count**

Replace lines 42-46 in `ui/src/components/codex/Folio.tsx`:

```tsx
const folioCode = shortFolio(path);
const wordCount = useMemo(
  () => countWordsFromSlate(editor.initialValue),
  [editor.initialValue],
);
```

Update the `import` line at the top to include `countWordsFromSlate`:

```tsx
import { countWordsFromSlate, shortFolio } from "#/components/codex/folio-utils";
```

(Note: `editor.initialValue` only updates after a successful save, so the count is "saved word count" rather than live keystroke count — acceptable trade-off; live count would require lifting Slate state out of `SlateEditor` and is out of scope.)

- [ ] **Step 6: Verify**

Run: `cd ui && bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/codex/folio-utils.ts ui/src/components/codex/folio-utils.test.ts ui/src/components/codex/Folio.tsx
git commit -m "feat(ui-codex): folio word count from slate value"
```

---

### Task 2: Surface `created_at` / `updated_at` from `usePageEditor`

**Files:**
- Modify: `ui/src/editor/usePageEditor.ts` (add returned fields)
- Modify: `ui/src/components/codex/Folio.tsx:50-51,213-217` (consume them)

- [ ] **Step 1: Extend `PageEditorState`**

Edit `ui/src/editor/usePageEditor.ts` interface near line 10:

```ts
interface PageEditorState {
  isLoading: boolean;
  error: unknown;
  initialValue: Descendant[];
  editorRevision: number;
  title: string;
  setTitle: (t: string) => void;
  tags: string[];
  setTags: (t: string[]) => void;
  aliases: string[];
  setAliases: (a: string[]) => void;
  saveStatus: SaveStatus;
  saveError: string | null;
  onSlateChange: (value: Descendant[], editor: Editor) => void;
  saveNow: () => void;
  createdAt: string | null;
  updatedAt: string | null;
}
```

- [ ] **Step 2: Populate the new fields from `page.meta`**

In the same file, locate the returned object at the end of `usePageEditor`. Pull the timestamps from `page?.meta`:

```ts
return {
  isLoading,
  error,
  initialValue,
  editorRevision,
  title,
  setTitle,
  tags,
  setTags,
  aliases,
  setAliases,
  saveStatus,
  saveError,
  onSlateChange,
  saveNow,
  createdAt: page?.meta?.created_at ?? null,
  updatedAt: page?.meta?.updated_at ?? null,
};
```

(If the existing return uses spread/intermediate variable, append the two fields in the matching style.)

- [ ] **Step 3: Replace stub timestamps in Folio**

Edit `ui/src/components/codex/Folio.tsx`. Remove these lines (currently 50-51):

```tsx
const updatedAt = useMemo(() => new Date().toLocaleTimeString(), [path]);
const draftedAt = useMemo(() => new Date().toLocaleDateString(), [path]);
```

Replace with derivations from the editor:

```tsx
const draftedAt = useMemo(
  () => fmtAbsoluteDate(editor.createdAt),
  [editor.createdAt],
);
const updatedAt = useMemo(
  () => fmtRelativeTime(editor.updatedAt),
  [editor.updatedAt],
);
```

Add the two formatters at the bottom of the file (above `buildToc`):

```tsx
function fmtAbsoluteDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

function fmtRelativeTime(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = Math.floor((Date.now() - t) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
```

The metadata strip text already reads `drafted {draftedAt} · last touched {updatedAt}` — no further change needed there.

- [ ] **Step 4: Verify**

Run: `cd ui && bun run typecheck && bun run lint && bun run test usePageEditor -- --run`
Expected: clean. Existing `usePageEditor` tests should continue to pass; if any break because they assert on the returned shape, extend their expectations to permit the new fields.

- [ ] **Step 5: Commit**

```bash
git add ui/src/editor/usePageEditor.ts ui/src/components/codex/Folio.tsx
git commit -m "feat(ui-codex): folio metadata strip uses real created/updated_at"
```

---

### Task 3: CodexFrame top-bar `vol. iv · clean` → real volume; drop `clean`

**Files:**
- Modify: `ui/src/components/codex/CodexFrame.tsx:99-102`

- [ ] **Step 1: Replace the strap**

In `CodexFrame.tsx`, replace the block:

```tsx
<div className="hidden border-r border-[var(--rule-soft)] px-3 py-1 text-[var(--ink-mute)] md:block">
  vol. iv · clean · {totalEntries} ent.
</div>
```

with:

```tsx
<div className="hidden border-r border-[var(--rule-soft)] px-3 py-1 text-[var(--ink-mute)] md:block">
  vol. {volumeRoman()} · {totalEntries} ent.
</div>
```

Add a helper at the bottom of the file:

```tsx
const ROMAN_UPPER = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
function volumeRoman(): string {
  // Volume = current calendar year - 2022 (project inception year), clamped 1..12 then numeric.
  const year = new Date().getFullYear();
  const idx = Math.max(1, year - 2022);
  return ROMAN_UPPER[idx - 1] ?? String(idx);
}
```

If the project inception year is wrong, fix the offset; this plan picks 2022 because the codebase began in 2024 and the user's existing `vol. iv` matches `2026 - 2022 = 4`.

- [ ] **Step 2: Verify**

Run: `cd ui && bun run typecheck && bun run lint`
Expected: clean. Sanity-check in browser: top bar reads `vol. IV · {N} ent.`.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/codex/CodexFrame.tsx
git commit -m "refactor(ui-codex): drop hardcoded vol/clean strap from top bar"
```

---

### Task 4: Bottom-bar `idx ✓` reflects stats query; drop `agent · idle`

**Files:**
- Modify: `ui/src/components/codex/CodexFrame.tsx:215-218`

- [ ] **Step 1: Pull stats query state**

At the top of `CodexFrame` near line 35 where `useStats()` is destructured, capture the loading flag:

```tsx
const { data: stats, isError: statsError } = useStats();
```

- [ ] **Step 2: Replace the bottom strap**

Replace lines 215-218:

```tsx
<span className="px-3 py-[2px] opacity-70">
  idx ✓ · sync {syncStatus === "connected" ? "✓" : syncStatus === "connecting" ? "…" : "✗"} · agent · idle
</span>
```

with:

```tsx
<span className="px-3 py-[2px] opacity-70">
  idx {statsError ? "✗" : stats ? "✓" : "…"} · sync {syncStatus === "connected" ? "✓" : syncStatus === "connecting" ? "…" : "✗"}
</span>
```

(Drops `agent · idle` entirely. No agent system exists; resurrecting it later belongs in a separate spec.)

- [ ] **Step 3: Verify**

Run: `cd ui && bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/codex/CodexFrame.tsx
git commit -m "fix(ui-codex): bottom bar idx reflects stats query, drop agent stub"
```

---

### Task 5: Atrium "Recently Inscribed" sub-count

**Files:**
- Modify: `ui/src/components/codex/Atrium.tsx:138-141`

- [ ] **Step 1: Replace the sub-count**

```tsx
<span style={{ color: "var(--ink-mute)", fontSize: 9 }}>
  {romanLower(Math.min(recent.length, totalEntries))} of {romanLower(totalEntries)}
</span>
```

(`romanLower` already exists in this file at the bottom.)

- [ ] **Step 2: Verify**

Run: `cd ui && bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/codex/Atrium.tsx
git commit -m "fix(ui-codex): atrium recently-inscribed sub-count is real"
```

---

### Task 6: Diurnal `MMXXVI · day {N}` → year from selected date

**Files:**
- Modify: `ui/src/components/codex/Diurnal.tsx:210-212`

- [ ] **Step 1: Compute year roman**

Add this helper near the bottom of `Diurnal.tsx`, alongside `dayOfYear`:

```tsx
function yearRoman(year: number): string {
  // Years 2000+: M·M followed by lowered tail. We render only 2000-2099 cleanly.
  const tens = Math.floor((year - 2000) / 10);
  const ones = (year - 2000) % 10;
  return `MM${"X".repeat(tens)}${ones === 0 ? "" : ROMAN_ONES[ones - 1]}`;
}
const ROMAN_ONES = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"];
```

- [ ] **Step 2: Replace the strap**

```tsx
<div className="cl-mono" style={{ fontSize: 11 }}>
  {yearRoman(parseDate(selectedDate).getFullYear())} · day {dayOfYear(parseDate(selectedDate))}
</div>
```

- [ ] **Step 3: Verify**

Run: `cd ui && bun run typecheck && bun run lint`
Expected: clean. Browser sanity: navigating to dates in 2026 still shows `MMXXVI`; navigating to 2025 shows `MMXXV`.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/codex/Diurnal.tsx
git commit -m "fix(ui-codex): diurnal year strap derives from selected date"
```

---

### Task 7: Gazetteer `IV · MMXXVI` strap

**Files:**
- Modify: `ui/src/components/codex/Gazetteer.tsx:30-36`

- [ ] **Step 1: Compute month/year**

Replace the strap:

```tsx
<div className="cl-mono" style={{ fontSize: 10, color: "var(--ink-mute)" }}>
  {filtered.length} entries · {tag ? `subject: #${tag}` : "subjects: all"} · {monthRoman(now)} · {yearRoman(now.getFullYear())}
</div>
```

Add helpers at the bottom of the file:

```tsx
const MONTH_ROMAN = ["I","II","III","IV","V","VI","VII","VIII","IX","X","XI","XII"];
function monthRoman(d: Date): string { return MONTH_ROMAN[d.getMonth()]; }

const ROMAN_ONES = ["I","II","III","IV","V","VI","VII","VIII","IX"];
function yearRoman(y: number): string {
  const tens = Math.floor((y - 2000) / 10);
  const ones = (y - 2000) % 10;
  return `MM${"X".repeat(tens)}${ones === 0 ? "" : ROMAN_ONES[ones - 1]}`;
}
```

Inside the component, just above the return: `const now = useMemo(() => new Date(), []);`

- [ ] **Step 2: Verify**

Run: `cd ui && bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/codex/Gazetteer.tsx
git commit -m "fix(ui-codex): gazetteer strap shows current month and year"
```

---

### Task 8: CommandPalette version footer

**Files:**
- Modify: `ui/vite.config.ts`
- Modify: `ui/src/components/codex/CommandPalette.tsx:347-350`

- [ ] **Step 1: Expose package version via Vite `define`**

Open `ui/vite.config.ts`. Inside the `defineConfig({ … })` object add (or extend) a `define` block:

```ts
import pkg from "./package.json" with { type: "json" };

// inside defineConfig:
define: {
  __APP_VERSION__: JSON.stringify(pkg.version),
},
```

Add a global ambient declaration. Create or open `ui/src/vite-env.d.ts` and append:

```ts
declare const __APP_VERSION__: string;
```

(If `vite-env.d.ts` already exists with reference triple-slashes, leave them and append the declaration.)

- [ ] **Step 2: Wire footer**

In `CommandPalette.tsx` replace `console.clepsydra · v0.4.1` with:

```tsx
<span>console.clepsydra · v{__APP_VERSION__}</span>
```

- [ ] **Step 3: Verify**

Run: `cd ui && bun run typecheck && bun run build`
Expected: build succeeds; the bundled console footer reads the value from `package.json`.

- [ ] **Step 4: Commit**

```bash
git add ui/vite.config.ts ui/src/vite-env.d.ts ui/src/components/codex/CommandPalette.tsx
git commit -m "feat(ui-codex): command palette footer reads app version"
```

---

## Wave 2 — Backend nudges + new hooks

### Task 9: Add `last_indexed_at` to `VaultStats`

**Files:**
- Modify: `src/api/index_routes.rs:94-102` (struct), `:467-520` (handler)
- Modify: `src/api/openapi.rs` (no change if struct already registered)
- Test: `src/api/index_routes.rs` test module (or new `tests/`)

- [ ] **Step 1: Write the failing handler test**

Locate the existing test module for index_routes (search `#[cfg(test)]` in the file or sibling `*_test.rs`). Add:

```rust
#[tokio::test]
async fn stats_returns_last_indexed_at_when_pages_exist() {
    let env = TestEnv::with_pages(&[
        ("alpha.md", "# alpha"),
        ("beta.md", "# beta"),
    ]).await;
    let stats: VaultStats = env.get_json("/api/vault/index/stats").await;
    assert!(
        stats.last_indexed_at.is_some(),
        "expected last_indexed_at to be set when pages exist",
    );
}

#[tokio::test]
async fn stats_returns_null_last_indexed_at_for_empty_vault() {
    let env = TestEnv::empty().await;
    let stats: VaultStats = env.get_json("/api/vault/index/stats").await;
    assert!(stats.last_indexed_at.is_none());
}
```

(Use whatever `TestEnv` analogue is established in the rest of the file. If none exists, hand-roll using existing tests as a template — do not invent new infrastructure.)

- [ ] **Step 2: Run tests, expect failure**

Run: `cargo test stats_returns_last_indexed_at`
Expected: FAIL — `no field 'last_indexed_at' on type 'VaultStats'`.

- [ ] **Step 3: Extend the struct**

Edit `src/api/index_routes.rs` lines 94-102:

```rust
#[derive(Debug, Serialize, ToSchema)]
pub struct VaultStats {
    pages: i64,
    links_total: i64,
    links_resolved: i64,
    links_unresolved: i64,
    tags: i64,
    attachments: i64,
    /// RFC3339 timestamp of the most recent `pages.updated_at`, or null on empty vault.
    #[serde(skip_serializing_if = "Option::is_none")]
    last_indexed_at: Option<String>,
}
```

- [ ] **Step 4: Populate the field**

Inside `pub async fn stats(...)`, extend the `interact` block. Add a query alongside the existing tuple:

```rust
let last_indexed_at: Option<String> = conn
    .query_row(
        "SELECT MAX(updated_at) FROM pages",
        [],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()?
    .flatten();
```

Then in the final `Ok(Json(VaultStats { … }))` add `last_indexed_at,`.

If the `pages` table column for updated_at is named differently, grep `src/vault/index.rs` for the schema and use the canonical column name.

- [ ] **Step 5: Re-run tests**

Run: `cargo test stats_returns_last_indexed_at`
Expected: PASS.

- [ ] **Step 6: Regenerate OpenAPI schema and frontend types**

Run:
```bash
cargo run -- serve &
sleep 2
cd ui && bun run openapi
kill %1
```

Confirm `ui/src/api/schema.d.ts` now includes `last_indexed_at: string | null`.

- [ ] **Step 7: Commit**

```bash
git add src/api/index_routes.rs ui/src/api/schema.d.ts
git commit -m "feat(api-index): expose last_indexed_at on vault stats"
```

---

### Task 10: Wire `last collated` in CodexFrame

**Files:**
- Modify: `ui/src/components/codex/CodexFrame.tsx:222-225`

- [ ] **Step 1: Render relative time**

Replace:

```tsx
<span className="px-3 py-[2px]" style={{ borderLeft: "1px solid var(--bar-rule)" }}>
  last collated {clock} GMT
</span>
```

with:

```tsx
<span className="px-3 py-[2px]" style={{ borderLeft: "1px solid var(--bar-rule)" }}>
  last collated {fmtCollated(stats?.last_indexed_at)}
</span>
```

Add helper at the bottom:

```tsx
function fmtCollated(iso?: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = Math.floor((Date.now() - t) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
```

(Yes, this duplicates `fmtRelativeTime` from Folio — that is intentional. Three almost-identical instances is the threshold for extracting; we have two.)

- [ ] **Step 2: Verify**

Run: `cd ui && bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/codex/CodexFrame.tsx
git commit -m "feat(ui-codex): bottom bar shows real last-indexed time"
```

---

### Task 11: `useOutlinks` hook + Folio bibliography count

**Files:**
- Create: `ui/src/api/outlinks.ts`
- Modify: `ui/src/api/index.ts` (re-export)
- Modify: `ui/src/components/codex/Folio.tsx:235-239`

- [ ] **Step 1: Add the hook**

```ts
// ui/src/api/outlinks.ts
import { $api } from "./client";

export function useOutlinks(path: string) {
  return $api.useQuery(
    "get",
    "/api/vault/index/outlinks/{path}",
    { params: { path: { path } } },
    { enabled: !!path },
  );
}
```

If the OpenAPI types do not include `/api/vault/index/outlinks/{path}`, regenerate them first (`bun run openapi`). The Rust route already exists at `src/api/index_routes.rs:169`.

- [ ] **Step 2: Re-export**

Append to `ui/src/api/index.ts`:

```ts
export { useOutlinks } from "./outlinks";
```

- [ ] **Step 3: Use the count in Folio**

Edit `Folio.tsx`. Near the top of the component:

```tsx
const { data: outlinks } = useOutlinks(path);
```

Add the import:

```tsx
import { useBacklinks, useOutlinks } from "#/api/index";
```

Replace the bibliography line in the triplet (line 237):

```tsx
<span style={{ borderBottom: "1px dotted var(--ink)", cursor: "pointer" }}>
  ⌥ bibliography · {outlinks?.length ?? 0}
</span>
```

(Click handler stays a no-op for now — fanning out to a sidebar is a separate UX task.)

- [ ] **Step 4: Verify**

Run: `cd ui && bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/outlinks.ts ui/src/api/index.ts ui/src/components/codex/Folio.tsx
git commit -m "feat(ui-codex): folio bibliography count from outlinks endpoint"
```

---

### Task 12: Backend `/api/vault/index/similar/{path}` endpoint

**Files:**
- Modify: `src/api/index_routes.rs` (router + handler + struct)
- Modify: `src/api/openapi.rs` (register route)
- Test: same crate

The semantics: given a page, return up to N other pages ranked by Jaccard similarity of their tag sets (numerator: shared tags; denominator: union). Tie-break by shared backlink count, then by path. Return 0 results for an untagged page rather than erroring.

- [ ] **Step 1: Write the failing handler test**

```rust
#[tokio::test]
async fn similar_returns_pages_sharing_tags() {
    let env = TestEnv::with_pages(&[
        ("a.md", "---\ntags: [foo, bar]\n---\nA"),
        ("b.md", "---\ntags: [foo, bar, baz]\n---\nB"),
        ("c.md", "---\ntags: [foo]\n---\nC"),
        ("d.md", "---\ntags: [unrelated]\n---\nD"),
    ]).await;

    let result: SimilarResponse = env.get_json("/api/vault/index/similar/a.md").await;
    let paths: Vec<&str> = result.items.iter().map(|i| i.path.as_str()).collect();

    assert_eq!(paths, vec!["b.md", "c.md"]);
    // d.md must not appear (no tag overlap)
    assert!(!paths.contains(&"d.md"));
}

#[tokio::test]
async fn similar_returns_empty_for_untagged_page() {
    let env = TestEnv::with_pages(&[
        ("a.md", "no tags here"),
        ("b.md", "---\ntags: [foo]\n---\nB"),
    ]).await;
    let result: SimilarResponse = env.get_json("/api/vault/index/similar/a.md").await;
    assert!(result.items.is_empty());
}
```

- [ ] **Step 2: Run tests; verify failure**

Run: `cargo test similar_`
Expected: FAIL — handler/struct not defined.

- [ ] **Step 3: Add types and route**

In `src/api/index_routes.rs`:

```rust
#[derive(Debug, Serialize, ToSchema)]
pub struct SimilarEntry {
    pub path: String,
    pub title: Option<String>,
    pub shared_tags: Vec<String>,
    pub score: f64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SimilarResponse {
    pub items: Vec<SimilarEntry>,
}
```

In `pub fn router()`:

```rust
.route("/similar/{*path}", get(similar))
```

Handler:

```rust
#[utoipa::path(
    get,
    path = "/index/similar/{path}",
    context_path = "/api/vault",
    tag = "Index",
    params(("path" = String, Path, description = "Vault-relative page path")),
    responses(
        (status = 200, description = "Similar pages by tag overlap", body = SimilarResponse),
        (status = 400, description = "Invalid path", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn similar(
    State(state): State<Arc<AppState>>,
    Path(path): Path<String>,
) -> Result<Json<SimilarResponse>, ApiError> {
    let vault_path = VaultPath::new(&path)
        .map_err(|e| ApiError::bad_request(format!("invalid path: {e}")))?;
    let items = state
        .index
        .similar_by_tags(vault_path, 12)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .into_iter()
        .map(|s| SimilarEntry {
            path: s.path,
            title: s.title,
            shared_tags: s.shared_tags,
            score: s.score,
        })
        .collect();
    Ok(Json(SimilarResponse { items }))
}
```

- [ ] **Step 4: Implement `similar_by_tags` on the index service**

In `src/vault/index.rs` (or wherever sibling methods like `backlinks` live), add:

```rust
pub struct SimilarRow {
    pub path: String,
    pub title: Option<String>,
    pub shared_tags: Vec<String>,
    pub score: f64,
}

pub async fn similar_by_tags(
    &self,
    target: VaultPath,
    limit: usize,
) -> Result<Vec<SimilarRow>, IndexError> {
    self.with_conn(move |conn| {
        // Look up target page id and its tag set
        let Some(target_id) = conn.query_row(
            "SELECT id FROM pages WHERE path = ?1",
            [target.as_str()],
            |r| r.get::<_, String>(0),
        ).optional()? else { return Ok(Vec::new()); };

        let target_tags: Vec<String> = conn
            .prepare("SELECT tag FROM page_tags WHERE page_id = ?1")?
            .query_map([&target_id], |r| r.get::<_, String>(0))?
            .collect::<Result<_, _>>()?;
        if target_tags.is_empty() { return Ok(Vec::new()); }

        // Candidate set: any other page sharing at least one tag
        let placeholders = target_tags.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let q = format!(
            "SELECT p.id, p.path, p.title, GROUP_CONCAT(pt.tag, '\u{1f}') AS tags
             FROM pages p
             JOIN page_tags pt ON pt.page_id = p.id
             WHERE p.id != ?1 AND p.id IN (
                 SELECT page_id FROM page_tags WHERE tag IN ({placeholders})
             )
             GROUP BY p.id"
        );
        let mut stmt = conn.prepare(&q)?;
        let mut params: Vec<&dyn rusqlite::ToSql> = vec![&target_id];
        for t in &target_tags { params.push(t); }
        let target_set: std::collections::HashSet<&str> =
            target_tags.iter().map(String::as_str).collect();

        let mut rows: Vec<SimilarRow> = stmt
            .query_map(params.as_slice(), |r| {
                let other_tags: String = r.get(3)?;
                let other_set: Vec<&str> = other_tags.split('\u{1f}').collect();
                let shared: Vec<String> = other_set
                    .iter()
                    .filter(|t| target_set.contains(*t))
                    .map(|s| s.to_string())
                    .collect();
                let union = target_set.len() + other_set.len() - shared.len();
                let score = if union == 0 { 0.0 } else { shared.len() as f64 / union as f64 };
                Ok(SimilarRow {
                    path: r.get(1)?,
                    title: r.get(2)?,
                    shared_tags: shared,
                    score,
                })
            })?
            .collect::<Result<_, _>>()?;
        rows.sort_by(|a, b| {
            b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.shared_tags.len().cmp(&a.shared_tags.len()))
                .then_with(|| a.path.cmp(&b.path))
        });
        rows.truncate(limit);
        Ok(rows)
    }).await
}
```

(`with_conn` / `IndexError` names match the surrounding code; if they differ, follow the established pattern in the same module.)

- [ ] **Step 5: Register the new types in `src/api/openapi.rs`**

Append `SimilarEntry`, `SimilarResponse` to the `components(schemas(…))` list and add the handler ident `crate::api::index_routes::similar` to the `paths(…)` list.

- [ ] **Step 6: Run tests**

Run: `cargo test similar_`
Expected: PASS.

- [ ] **Step 7: Regenerate the OpenAPI schema and frontend types**

```bash
cargo run -- serve &
sleep 2
cd ui && bun run openapi
kill %1
```

- [ ] **Step 8: Commit**

```bash
git add src/api/index_routes.rs src/vault/index.rs src/api/openapi.rs ui/src/api/schema.d.ts
git commit -m "feat(api-index): similar-pages endpoint by tag jaccard"
```

---

### Task 13: `useSimilar` hook + Folio similar count

**Files:**
- Create: `ui/src/api/similar.ts`
- Modify: `ui/src/api/index.ts`
- Modify: `ui/src/components/codex/Folio.tsx`

- [ ] **Step 1: Hook**

```ts
// ui/src/api/similar.ts
import { $api } from "./client";

export function useSimilar(path: string) {
  return $api.useQuery(
    "get",
    "/api/vault/index/similar/{path}",
    { params: { path: { path } } },
    { enabled: !!path },
  );
}
```

Re-export from `ui/src/api/index.ts`:

```ts
export { useSimilar } from "./similar";
```

- [ ] **Step 2: Use the count in Folio**

In `Folio.tsx` import and use:

```tsx
import { useBacklinks, useOutlinks, useSimilar } from "#/api/index";
// …
const { data: similar } = useSimilar(path);
```

Replace the similar line in the triplet (line 234):

```tsx
<span style={{ borderBottom: "1px dotted var(--ink)", cursor: "pointer" }}>
  ≈ similar · {similar?.items.length ?? 0}
</span>
```

- [ ] **Step 3: Verify**

Run: `cd ui && bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/api/similar.ts ui/src/api/index.ts ui/src/components/codex/Folio.tsx
git commit -m "feat(ui-codex): folio similar-pages count"
```

---

### Task 14: Per-page word_count on `ContentEntry`

**Files:**
- Modify: `src/api/index_routes.rs` (struct + content_index handler)
- Modify: `ui/src/components/codex/Gazetteer.tsx`

- [ ] **Step 1: Backend test**

```rust
#[tokio::test]
async fn content_index_includes_word_count() {
    let env = TestEnv::with_pages(&[
        ("alpha.md", "# Alpha\n\nthe quick brown fox jumps"),
    ]).await;
    let resp: ContentIndexResponse = env.get_json("/api/vault/index/content-index").await;
    let alpha = resp.items.iter().find(|i| i.path == "alpha.md").unwrap();
    assert_eq!(alpha.word_count, Some(6));
}
```

Run: `cargo test content_index_includes_word_count`
Expected: FAIL — `word_count` not on entry.

- [ ] **Step 2: Add field**

Locate `pub struct ContentEntry` (search the file). Add:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub word_count: Option<i64>,
```

- [ ] **Step 3: Populate it**

In the `content_index` handler at lines ~857-877 (where `created_at, updated_at, description` are computed from disk), also compute words from the page body:

```rust
let word_count = page.body.split_whitespace().count() as i64;
```

…and include `word_count: Some(word_count)` in the constructor; for entries where the file does not exist, leave `word_count: None`.

- [ ] **Step 4: Run tests**

Run: `cargo test content_index_includes_word_count`
Expected: PASS.

- [ ] **Step 5: Regenerate types**

```bash
cargo run -- serve &
sleep 2
cd ui && bun run openapi
kill %1
```

- [ ] **Step 6: Use it in Gazetteer**

In `Gazetteer.tsx` replace the word-count badge (lines 119-126):

```tsx
<div className="cl-mono" style={{ fontSize: 8, color: "var(--ink-mute)", letterSpacing: "0.04em" }}>
  {n.word_count != null ? `${n.word_count} wd` : "—"}
</div>
```

- [ ] **Step 7: Verify**

Run: `cd ui && bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/api/index_routes.rs ui/src/api/schema.d.ts ui/src/components/codex/Gazetteer.tsx
git commit -m "feat(api-index): expose per-page word_count on content index"
```

---

## Wave 3 — Net-new interactive features

### Task 15: Marginalia from page footnote definitions

**Files:**
- Create: `ui/src/components/codex/footnotes.ts`
- Create: `ui/src/components/codex/footnotes.test.ts`
- Modify: `ui/src/components/codex/Folio.tsx`

The data path: parse the saved markdown body (which the editor surfaces in `usePageEditor` via `page.body`) for `[^id]: text` footnote definitions and render them as numbered sidenotes. This avoids re-walking Slate state and keeps the helper trivially testable.

First we need `usePageEditor` to surface `bodyMarkdown`.

- [ ] **Step 1: Surface `bodyMarkdown` from `usePageEditor`**

In `ui/src/editor/usePageEditor.ts`, near the existing return-shape augmentation from Task 2, add `bodyMarkdown: page?.body ?? ""` to the interface and the returned object. (Use `?.body` so it stays `""` while loading.)

- [ ] **Step 2: Write the failing test**

```ts
// ui/src/components/codex/footnotes.test.ts
import { describe, expect, it } from "vitest";
import { extractFootnoteDefinitions } from "./footnotes";

describe("extractFootnoteDefinitions", () => {
  it("returns empty list when none present", () => {
    expect(extractFootnoteDefinitions("plain prose, no notes.")).toEqual([]);
  });

  it("captures id and text for a single-line definition", () => {
    const md = "Body[^one] text.\n\n[^one]: A footnote about Polars.";
    expect(extractFootnoteDefinitions(md)).toEqual([
      { id: "one", text: "A footnote about Polars." },
    ]);
  });

  it("captures multi-line definition until blank line or next definition", () => {
    const md = [
      "[^a]: first line",
      "    second line",
      "    third line",
      "",
      "[^b]: another",
    ].join("\n");
    expect(extractFootnoteDefinitions(md)).toEqual([
      { id: "a", text: "first line second line third line" },
      { id: "b", text: "another" },
    ]);
  });

  it("orders results by appearance, deduping by id (first wins)", () => {
    const md = "[^x]: first\n\n[^x]: second";
    expect(extractFootnoteDefinitions(md)).toEqual([{ id: "x", text: "first" }]);
  });
});
```

- [ ] **Step 3: Run tests; expect failure**

Run: `cd ui && bun run test footnotes -- --run`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement extractor**

```ts
// ui/src/components/codex/footnotes.ts
export type FootnoteDef = { id: string; text: string };

export function extractFootnoteDefinitions(md: string): FootnoteDef[] {
  if (!md) return [];
  const lines = md.split("\n");
  const out: FootnoteDef[] = [];
  const seen = new Set<string>();
  let current: FootnoteDef | null = null;
  const startRe = /^\[\^([^\]]+)\]:\s*(.*)$/;

  const flush = () => {
    if (!current) return;
    if (!seen.has(current.id)) {
      seen.add(current.id);
      out.push({ id: current.id, text: current.text.trim() });
    }
    current = null;
  };

  for (const raw of lines) {
    const m = raw.match(startRe);
    if (m) {
      flush();
      current = { id: m[1], text: m[2] };
      continue;
    }
    if (current) {
      if (raw.trim() === "") {
        flush();
        continue;
      }
      // continuation line — collapse leading indent to single space
      current.text += ` ${raw.trim()}`;
    }
  }
  flush();
  return out;
}
```

- [ ] **Step 5: Run tests; expect pass**

Run: `cd ui && bun run test footnotes -- --run`
Expected: PASS.

- [ ] **Step 6: Replace static Marginalia copy**

In `Folio.tsx`, replace the marginalia section (lines 302-310) with:

```tsx
<div className="cl-cap mt-4 mb-1" style={{ fontSize: 9 }}>
  § Marginalia · {footnotes.length}
</div>
<hr className="cl-rule-soft" />
{footnotes.length === 0 ? (
  <p className="cl-marg mt-1" style={{ margin: 0 }}>
    No sidenotes — add <span className="cl-mono">[^1]</span> in the body and a definition
    <span className="cl-mono"> [^1]: …</span> below to populate this rail.
  </p>
) : (
  <ol className="cl-serif mt-1" style={{ paddingLeft: 18, margin: 0, fontSize: 11 }}>
    {footnotes.map((f, i) => (
      <li key={f.id} style={{ marginBottom: 4 }}>
        <span className="cl-mono" style={{ color: "var(--accent-deep)", marginRight: 4 }}>
          {i + 1}.
        </span>
        {f.text}
      </li>
    ))}
  </ol>
)}
```

Add the derivation near the other `useMemo`s:

```tsx
const footnotes = useMemo(
  () => extractFootnoteDefinitions(editor.bodyMarkdown),
  [editor.bodyMarkdown],
);
```

And the import:

```tsx
import { extractFootnoteDefinitions } from "#/components/codex/footnotes";
```

- [ ] **Step 7: Verify**

Run: `cd ui && bun run typecheck && bun run lint && bun run test footnotes -- --run`
Expected: clean. Browser sanity: open a page with footnotes, see them in the right rail.

- [ ] **Step 8: Commit**

```bash
git add ui/src/components/codex/footnotes.ts ui/src/components/codex/footnotes.test.ts ui/src/components/codex/Folio.tsx ui/src/editor/usePageEditor.ts
git commit -m "feat(ui-codex): folio marginalia from page footnote definitions"
```

---

### Task 16: Inscribe modal (`+ Inscribe` button)

**Files:**
- Create: `ui/src/components/codex/InscribeModal.tsx`
- Modify: `ui/src/components/codex/Atrium.tsx` (wire button)
- Modify: `ui/src/store/ui.ts` (track open state — or use local state if the modal can be self-contained on Atrium)

For minimal blast radius use **local state on Atrium**, not a global store. Promote later if Inscribe is also reachable from the command palette.

- [ ] **Step 1: Modal component**

```tsx
// ui/src/components/codex/InscribeModal.tsx
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useCreatePage } from "#/api/pages";
import { useOpenTab } from "#/hooks/useOpenTab";

type Props = { onClose: () => void };

export function InscribeModal({ onClose }: Props) {
  const [path, setPath] = useState("");
  const [title, setTitle] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useCreatePage();
  const openTab = useOpenTab();
  const _navigate = useNavigate();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedPath = path.trim().replace(/^\/+/, "");
    if (!trimmedPath) {
      setError("path is required");
      return;
    }
    const finalPath = trimmedPath.endsWith(".md") ? trimmedPath : `${trimmedPath}.md`;
    const tags = tagsInput.split(/[, ]+/).map((t) => t.trim()).filter(Boolean);
    create.mutate(
      {
        params: { path: { path: finalPath } },
        body: { title: title.trim() || undefined, tags: tags.length ? tags : undefined },
      },
      {
        onSuccess: () => {
          openTab("page", finalPath, title.trim() || finalPath);
          onClose();
        },
        onError: (err) => setError((err as Error).message),
      },
    );
  };

  return (
    <div
      onMouseDown={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 50, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 80 }}
    >
      <form
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit}
        style={{ width: "88%", maxWidth: 520, background: "var(--paper)", color: "var(--ink)", border: "1.5px solid var(--ink)", boxShadow: "8px 8px 0 0 var(--ink)", padding: 14 }}
      >
        <div className="cl-cap mb-2" style={{ fontSize: 11 }}>Inscribe a new folio</div>
        <label className="cl-mono mb-2 block" style={{ fontSize: 10, color: "var(--ink-mute)" }}>
          path · vault-relative, .md optional
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            autoFocus
            placeholder="ideas/new-page"
            className="cl-mono mt-1 w-full border border-[var(--rule)] bg-transparent p-1 text-[12px]"
          />
        </label>
        <label className="cl-mono mb-2 block" style={{ fontSize: 10, color: "var(--ink-mute)" }}>
          title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="cl-mono mt-1 w-full border border-[var(--rule)] bg-transparent p-1 text-[12px]"
          />
        </label>
        <label className="cl-mono mb-3 block" style={{ fontSize: 10, color: "var(--ink-mute)" }}>
          tags · comma or space separated
          <input
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            className="cl-mono mt-1 w-full border border-[var(--rule)] bg-transparent p-1 text-[12px]"
          />
        </label>
        {error && <div className="cl-marg" style={{ color: "var(--accent-deep)", marginBottom: 8 }}>⁂ {error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className="cl-btn" onClick={onClose}>cancel</button>
          <button type="submit" className="cl-btn cl-btn-hot" disabled={create.isPending}>
            {create.isPending ? "inscribing…" : "inscribe"}
          </button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Wire from Atrium**

In `Atrium.tsx`, add state and the modal:

```tsx
import { useState } from "react";
import { InscribeModal } from "#/components/codex/InscribeModal";
// …
const [inscribeOpen, setInscribeOpen] = useState(false);
```

Replace the `+ Inscribe` button:

```tsx
<button type="button" className="cl-btn cl-btn-hot" onClick={() => setInscribeOpen(true)}>
  + Inscribe
</button>
```

Add at the end of the JSX (just before the closing fragment / outermost div):

```tsx
{inscribeOpen && <InscribeModal onClose={() => setInscribeOpen(false)} />}
```

(Place it inside the existing root `<div className="grid …">` is fine; portals not required because it overlays on top with `position: fixed`.)

- [ ] **Step 3: Verify**

Run: `cd ui && bun run typecheck && bun run lint`
Expected: clean. Browser sanity: click `+ Inscribe`, fill the form, submit, confirm a new tab opens on the new page.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/codex/InscribeModal.tsx ui/src/components/codex/Atrium.tsx
git commit -m "feat(ui-codex): inscribe modal for creating new folios"
```

---

### Task 17: Functional Constellation filters

**Files:**
- Create: `ui/src/components/codex/constellation-filters.ts`
- Create: `ui/src/components/codex/constellation-filters.test.ts`
- Modify: `ui/src/components/codex/Constellation.tsx`

Filters in scope:
- **orphans visible** — toggle inclusion of nodes with degree 0.
- **daily nodes hidden** — when on, hide nodes whose `path` starts with `journal/` (mirrors backend journaling convention; if it differs, grep `src/api/journal_routes.rs` for the storage prefix).
- **depth from active** — only show nodes within N hops of the active page (controls in `1` / `2` / `all`).

Subjects ("subjects · all") and time-window are deferred — both require additional query plumbing.

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/components/codex/constellation-filters.test.ts
import { describe, expect, it } from "vitest";
import { applyFilters } from "./constellation-filters";

const graph = {
  nodes: [
    { id: "a", path: "alpha.md", title: "Alpha" },
    { id: "b", path: "beta.md", title: "Beta" },
    { id: "c", path: "journal/2026-04-28.md", title: "Diurnal" },
    { id: "d", path: "delta.md", title: "Delta" }, // orphan
  ],
  edges: [
    { source: "a", target: "b", kind: "wikilink" },
    { source: "a", target: "c", kind: "wikilink" },
  ],
};

describe("applyFilters", () => {
  it("includes orphans by default", () => {
    const out = applyFilters(graph, { orphansVisible: true, hideDaily: false, depth: null, anchorId: null });
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("excludes orphans when toggled off", () => {
    const out = applyFilters(graph, { orphansVisible: false, hideDaily: false, depth: null, anchorId: null });
    expect(out.nodes.map((n) => n.id)).not.toContain("d");
  });

  it("hides daily journal nodes when toggled", () => {
    const out = applyFilters(graph, { orphansVisible: true, hideDaily: true, depth: null, anchorId: null });
    expect(out.nodes.map((n) => n.id)).not.toContain("c");
    // edges referring to removed nodes are dropped
    expect(out.edges.find((e) => e.target === "c")).toBeUndefined();
  });

  it("limits to N hops from anchor when depth is set", () => {
    const extended = {
      nodes: [...graph.nodes, { id: "e", path: "epsilon.md", title: "Epsilon" }],
      edges: [...graph.edges, { source: "b", target: "e", kind: "wikilink" }],
    };
    const out = applyFilters(extended, { orphansVisible: true, hideDaily: false, depth: 1, anchorId: "a" });
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
  });
});
```

- [ ] **Step 2: Run; expect failure**

Run: `cd ui && bun run test constellation-filters -- --run`

- [ ] **Step 3: Implement**

```ts
// ui/src/components/codex/constellation-filters.ts
import type { GraphEdge, GraphNode } from "#/api/types";

export type FilterOptions = {
  orphansVisible: boolean;
  hideDaily: boolean;
  depth: number | null;     // null = unlimited
  anchorId: string | null;  // required when depth is set
};

export function applyFilters(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  opts: FilterOptions,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  let nodes = graph.nodes;
  if (opts.hideDaily) {
    nodes = nodes.filter((n) => !n.path.startsWith("journal/"));
  }
  let edges = graph.edges.filter((e) => {
    const okSrc = nodes.some((n) => n.id === e.source);
    const okTgt = nodes.some((n) => n.id === e.target);
    return okSrc && okTgt;
  });
  if (!opts.orphansVisible) {
    const connected = new Set<string>();
    for (const e of edges) {
      connected.add(e.source);
      connected.add(e.target);
    }
    nodes = nodes.filter((n) => connected.has(n.id));
  }
  if (opts.depth != null && opts.anchorId) {
    const adj = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!adj.has(e.source)) adj.set(e.source, new Set());
      if (!adj.has(e.target)) adj.set(e.target, new Set());
      adj.get(e.source)!.add(e.target);
      adj.get(e.target)!.add(e.source);
    }
    const seen = new Set<string>([opts.anchorId]);
    let frontier = new Set<string>([opts.anchorId]);
    for (let i = 0; i < opts.depth; i++) {
      const next = new Set<string>();
      for (const id of frontier) {
        for (const nb of adj.get(id) ?? []) {
          if (!seen.has(nb)) { seen.add(nb); next.add(nb); }
        }
      }
      frontier = next;
      if (frontier.size === 0) break;
    }
    nodes = nodes.filter((n) => seen.has(n.id));
    edges = edges.filter((e) => seen.has(e.source) && seen.has(e.target));
  }
  return { nodes, edges };
}
```

- [ ] **Step 4: Run tests**

Run: `cd ui && bun run test constellation-filters -- --run`
Expected: PASS.

- [ ] **Step 5: Replace the Filters rail in `Constellation.tsx`**

Add filter state at top of component:

```tsx
import { useMemo, useState } from "react";
import { applyFilters, type FilterOptions } from "#/components/codex/constellation-filters";
import { useWorkspaceStore } from "#/store/workspace";
// …
const [orphansVisible, setOrphansVisible] = useState(true);
const [hideDaily, setHideDaily] = useState(false);
const [depth, setDepth] = useState<number | null>(null);
const activeTabId2 = useWorkspaceStore((s) => s.activeTabId);
const tabs = useWorkspaceStore((s) => s.tabs);
const anchorPath = tabs.find((t) => t.id === activeTabId2 && t.type === "page")?.path;
const anchorId = useMemo(
  () => graph?.nodes.find((n) => n.path === anchorPath)?.id ?? null,
  [graph, anchorPath],
);
const filtered = useMemo(
  () => applyFilters(graph!, { orphansVisible, hideDaily, depth, anchorId }),
  [graph, orphansVisible, hideDaily, depth, anchorId],
);
```

Replace use of `graph.nodes` / `graph.edges` in the component below the early-return so the rendered ForceGraph and the hubs/orphans sidebar use `filtered.nodes` / `filtered.edges`. The `fig. v · {N} nodes · {N} vertices` strap should also reflect filtered counts.

Replace the static filter rail JSX:

```tsx
<div className="cl-mono mt-1" style={{ fontSize: 11 }}>
  <label style={{ display: "block", cursor: "pointer" }}>
    <input
      type="checkbox"
      checked={orphansVisible}
      onChange={(e) => setOrphansVisible(e.target.checked)}
      style={{ marginRight: 4 }}
    />
    orphans visible
  </label>
  <label style={{ display: "block", cursor: "pointer" }}>
    <input
      type="checkbox"
      checked={hideDaily}
      onChange={(e) => setHideDaily(e.target.checked)}
      style={{ marginRight: 4 }}
    />
    daily nodes hidden
  </label>
  <div style={{ marginTop: 4 }}>
    depth ·{" "}
    {[1, 2, null].map((d) => (
      <button
        key={String(d)}
        type="button"
        onClick={() => setDepth(d)}
        style={{
          marginRight: 4,
          padding: "0 4px",
          background: depth === d ? "var(--accent)" : "transparent",
          color: depth === d ? "var(--paper)" : "var(--ink)",
          border: "1px solid var(--rule-soft)",
          cursor: anchorId || d == null ? "pointer" : "not-allowed",
          opacity: d != null && !anchorId ? 0.4 : 1,
        }}
        disabled={d != null && !anchorId}
        title={d != null && !anchorId ? "open a page tab to use depth" : undefined}
      >
        {d ?? "all"}
      </button>
    ))}
  </div>
</div>
```

- [ ] **Step 6: Verify**

Run: `cd ui && bun run typecheck && bun run lint && bun run test constellation-filters -- --run`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/codex/constellation-filters.ts ui/src/components/codex/constellation-filters.test.ts ui/src/components/codex/Constellation.tsx
git commit -m "feat(ui-codex): functional constellation filters (orphans/daily/depth)"
```

---

### Task 18: Gate Reading / Inquiry / Habits / Horologe panels behind a flag

**Files:**
- Modify: `ui/src/components/codex/Atrium.tsx`
- Modify: `ui/src/components/codex/Diurnal.tsx`

These features depend on domain models that don't exist yet. Hiding by default but keeping the markup behind an env flag preserves the design intent for future rollout while making the running app honest about what is real.

- [ ] **Step 1: Choose the flag name**

`VITE_ENABLE_PROSPECTIVE_PANELS` — set to `1` to show. (Vite exposes `import.meta.env.VITE_*`.)

- [ ] **Step 2: Atrium — gate the right-side decorative panels**

In `Atrium.tsx` add at the top of the component, alongside the other hooks:

```tsx
const showProspective = import.meta.env.VITE_ENABLE_PROSPECTIVE_PANELS === "1";
```

Wrap the **Horologe `cl-frame`** (the `<div className="cl-frame mb-3 px-3 py-2" …>` block at the top of the right-marginalia column) in `{showProspective && ( … )}`.

Wrap the **Reading + Inquiry two-column grid** (the `<div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2"> … </div>` block on the left column) in `{showProspective && ( … )}`.

Leave the "Codex Contains" stats panel, the tag cloud, the "Privatim" stamp, and the ASCII compass intact — those are either real or intentionally decorative.

- [ ] **Step 3: Diurnal — replace habits rail with honest empty**

In `Diurnal.tsx` replace the entire hardcoded habits block (lines 315-340) with:

```tsx
<div className="cl-cap mb-1" style={{ fontSize: 9 }}>§ Habits, this day</div>
<hr className="cl-rule-soft" />
<p className="cl-marg mt-1">— no habits configured —</p>
```

(Habits are deferred; once a habits feature spec lands, this stub gets replaced with the real grid.)

- [ ] **Step 4: Verify**

Run: `cd ui && bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/codex/Atrium.tsx ui/src/components/codex/Diurnal.tsx
git commit -m "refactor(ui-codex): gate prospective panels behind env flag, replace habits stub"
```

---

## Wave 4 — Deferred (out of scope; document only)

For each of the deferred items, append a stub section to `_features/` so they are tracked but not implemented now. This keeps the manifest honest.

### Task 19: Author deferred-feature stubs

**Files:**
- Create: `_features/codex-reading-log.md`
- Create: `_features/codex-inquiry-list.md`
- Create: `_features/codex-habits.md`
- Create: `_features/codex-horologe.md`

- [ ] **Step 1: Each stub follows this template (replace `<feature>` and the body)**

```markdown
# <Feature> · stub

**Status:** deferred (placed behind `VITE_ENABLE_PROSPECTIVE_PANELS` flag in Atrium/Diurnal)
**Why deferred:** requires a domain model that does not yet exist in the vault layer.

## What's needed
- <list the data model, endpoints, UI surfaces required>

## Open questions
- <list>

## Touchpoints when this lands
- ui/src/components/codex/Atrium.tsx · the gated panel re-renders with real data
- ui/src/api/<feature>.ts · new hook
- src/api/<feature>_routes.rs · new endpoints
- src/vault/<feature>.rs · domain logic
```

Fill in each stub with one to two paragraphs. No code in these stubs — they are scope markers, not plans.

- [ ] **Step 2: Commit**

```bash
git add _features/codex-reading-log.md _features/codex-inquiry-list.md _features/codex-habits.md _features/codex-horologe.md
git commit -m "docs(features): stubs for deferred codex panels"
```

---

## Final verification

- [ ] **Run full typecheck + lint + tests**

```bash
cd ui && bun run typecheck && bun run lint && bun run test -- --run
cd .. && cargo test && cargo clippy --all-targets -- -D warnings
```

Expected: all green.

- [ ] **Manual smoke pass through the UI**

Touch each route and visually confirm the wired elements behave as described in the decision table:
- `/` (Atrium): subcount, `+ Inscribe` modal, prospective panels hidden when flag unset.
- `/journal` (Diurnal): year strap reflects selected date, habits rail honest.
- `/workspace` (Folio): metadata strip uses real timestamps, body word count accurate, similar/bibliography counts non-zero on a tagged page with outlinks, marginalia rail lists footnotes from the body.
- `/workspace` (Constellation): filters affect the chart and sidebar.
- `/gazetteer`: strap reflects month/year, word counts present.
- Top/bottom bars: volume, idx state, last-collated, no agent strap.
- ⌘K palette: footer reads version from `package.json`.

- [ ] **Final commit if any drift**

If smoke testing surfaced a small inconsistency, commit the fix with `fix(ui-codex): …`.

---

## Summary of remaining decorative-on-purpose elements

These are intentionally not wired and are not bugs:

- `READ` / `UTF-8` straps in the bottom bar
- `PL. *` plate codes
- `READ · IV·xxviii` rotated stamp on Folio
- ASCII compass / quill / frontispiece glyphs
- Registration corners on Constellation, "N ↑ · scale 1:1"
- "Privatim · Lectori Suo" institutional stamp
- "fig. iii / iv / v" captions
- Atrium frontispiece "clepsydra's water is three-quarters spent" prose

If any of these later become candidates for wiring (e.g. plate codes tied to an actual page-numbering scheme), spec it as its own feature.
