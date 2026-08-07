# Diurnal → Folio Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the standalone DIURNAL view and present journal entries as ordinary workspace folio tabs, with journal-specific affordances (day nav, FASTI timeline, marginalia, aside capture) surviving as a bespoke kind presentation and a global palette command.

**Architecture:** Journal pages open as normal FOLIO tabs. Specialisation flows through the `kindPresentation` registry (a JOURNAL `metaExtras` block + a read-only title formatter); draft-first-write reuses `usePageEditor`'s existing `ensure` option, wired only when the tab path is today's journal. The backend gains one behavior: plain-prose captures are time-stamped.

**Tech Stack:** Rust (Axum 0.8, chrono, rusqlite) · React 19 + TanStack Router/Query + Zustand · vitest + @testing-library/react · axum-test integration tests · lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-08-07-diurnal-folio-unification-design.md`

## Global Constraints

- Execute on a feature branch off `develop`: `feature/diurnal-folio-unification` (worktree per superpowers:using-git-worktrees).
- Frontend commands run from `ui/` with Bun (`bun run typecheck|lint|test|knip`); backend uses standard cargo. Never `cd` into the repo root; only `cd ui &&` when the tool requires it.
- Path alias `#/` → `ui/src/`; never relative imports across directories.
- Biome formatting: 2-space indent, double quotes. `bun run format` before committing UI code.
- Vessel aesthetic: zero border-radius, `cl-*` utility classes, semantic tokens (`text-ink`, `border-rule`, `text-accent`, …) — no raw colors.
- Auto-generated files are never hand-edited: `ui/src/routeTree.gen.ts`, `ui/src/api/schema.d.ts`.
- No OpenAPI change in this feature (journal routes carry no utoipa annotations); do not run `bun run openapi`.
- TDD: every task writes its failing test first, sees it fail, then implements.

---

### Task 1: Backend — time-stamped capture entries

**Files:**
- Modify: `src/api/journal.rs` (capture handler, ~line 388–411)
- Test: `tests/api_journal_test.rs` (capture section, after `capture_appends_multiple_entries` ~line 341)

**Interfaces:**
- Consumes: existing `capture_today` handler; test fixture `setup_server()` with `FixedClock` at `2042-05-17T23:59:59Z` (so the stamp is always `23:59`).
- Produces: private `fn format_capture_entry(now: DateTime<Utc>, content: &str) -> String` and `fn is_block_construct(line: &str) -> bool` in `src/api/journal.rs`. Capture behavior: plain prose becomes `- HH:MM — <content>`; content whose first line already starts as a markdown block construct (`- `, `* `, `+ `, `> `, `#`, ```` ``` ````, or `1. ` / `1) `-style ordered items) is appended verbatim so task/outline captures keep their syntax at line start.

- [ ] **Step 1: Write the failing tests**

Append to the capture section of `tests/api_journal_test.rs`:

```rust
#[tokio::test]
async fn capture_stamps_plain_prose() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/journal/today/capture")
        .json(&serde_json::json!({ "content": "a passing thought" }))
        .await
        .assert_status_ok();

    let page = server.get("/api/vault/journal/today").await;
    let body: serde_json::Value = page.json();
    let text = body["body"].as_str().unwrap();
    assert!(
        text.contains("- 23:59 — a passing thought"),
        "plain prose must be wrapped as a stamped list item, got: {text}"
    );
}

#[tokio::test]
async fn capture_leaves_structured_content_unstamped() {
    let (server, _tmp) = setup_server();

    server
        .post("/api/vault/journal/today/capture")
        .json(&serde_json::json!({ "content": "- [ ] New task [due:: 2026-03-01]" }))
        .await
        .assert_status_ok();

    let page = server.get("/api/vault/journal/today").await;
    let body: serde_json::Value = page.json();
    let text = body["body"].as_str().unwrap();
    assert!(text.contains("- [ ] New task [due:: 2026-03-01]"));
    assert!(
        !text.contains("23:59 — -"),
        "block constructs must not be wrapped in a stamp, got: {text}"
    );
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --test api_journal_test capture`
Expected: `capture_stamps_plain_prose` FAILS (body contains raw `a passing thought`, no stamp); `capture_leaves_structured_content_unstamped` passes already (that's fine — it pins the invariant the implementation must not break).

- [ ] **Step 3: Implement the stamp**

In `src/api/journal.rs`, above `capture_today`:

```rust
/// True when `line` already opens a markdown block construct (list item,
/// task, ordered item, heading, blockquote, code fence). Such captures keep
/// their syntax at line start; only plain prose gets a time stamp.
fn is_block_construct(line: &str) -> bool {
    if line.starts_with("- ")
        || line.starts_with("* ")
        || line.starts_with("+ ")
        || line.starts_with("> ")
        || line.starts_with('#')
        || line.starts_with("```")
    {
        return true;
    }
    let digits = line.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 {
        return false;
    }
    let rest = &line[digits..];
    rest.starts_with(". ") || rest.starts_with(") ")
}

/// Wrap a plain-prose capture as `- HH:MM — <content>` using the same clock
/// that defines "today". Structured content passes through verbatim.
fn format_capture_entry(now: DateTime<Utc>, content: &str) -> String {
    let first_line = content.lines().next().unwrap_or("").trim_start();
    if is_block_construct(first_line) {
        content.to_string()
    } else {
        format!("- {} — {}", now.format("%H:%M"), content)
    }
}
```

(If `chrono::{DateTime, Utc}` are not already imported at the top of `src/api/journal.rs` — the handler currently gets `now` by inference — add the `use` line.)

In `capture_today`, replace:

```rust
    new_body.push_str(&req.content);
```

with:

```rust
    new_body.push_str(&format_capture_entry(now, &req.content));
```

(`now` is `Copy`; its later use for `meta.updated_at` is unaffected.)

- [ ] **Step 4: Run the journal test file**

Run: `cargo test --test api_journal_test`
Expected: all PASS, including the pre-existing `capture_appends_to_today`, `capture_creates_journal_first_if_missing`, `capture_appends_multiple_entries` — note `capture_appends_multiple_entries` captures the plain strings `First entry` / `Second entry`, which now arrive stamped; its `contains` assertions still pass.

- [ ] **Step 5: Check for other capture consumers in tests**

Run: `rg -l "today/capture" tests/`
For every other file found (e.g. `e2e_tasks_journal_test.rs` captures task lines): run that test file (`cargo test --test <name>`) and confirm task-syntax captures still index (they are block constructs → verbatim). Fix any assertion that assumed plain prose lands unstamped.

- [ ] **Step 6: fmt, clippy, commit**

```bash
cargo fmt
cargo clippy --tests
git add src/api/journal.rs tests/
git commit -m "feat(journal): time-stamp plain-prose capture entries"
```

---

### Task 2: `ui/src/lib/journal.ts` — pure journal helpers

**Files:**
- Create: `ui/src/lib/journal.ts`
- Test: `ui/src/lib/journal.test.ts`

**Interfaces:**
- Consumes: `localDateKey`, `parseLocalDate`, `isoAddDays` from `#/lib/time`.
- Produces (later tasks import all of these from `#/lib/journal`):
  - `journalPathForDate(dateKey: string): string`
  - `todayJournalPath(): string`
  - `journalDateFromPath(path: string): string | null`
  - `journalDayLabel(path: string, title: string): string`
  - `nearestEntry(writtenKeys: readonly string[], from: string, direction: -1 | 1): string | null`
  - `type FastiRow = { dateKey: string; path: string | null }`
  - `fastiRows(entries: readonly { path: string; journal_date: string }[], todayKey: string, count: number): FastiRow[]`
  - `shortDate(dateKey: string): string`
  - `relativeDays(dateKey: string, todayKey: string): string`

- [ ] **Step 1: Write the failing tests**

`ui/src/lib/journal.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  fastiRows,
  journalDateFromPath,
  journalDayLabel,
  journalPathForDate,
  nearestEntry,
  relativeDays,
  shortDate,
} from "#/lib/journal";

describe("journalPathForDate / journalDateFromPath", () => {
  it("round-trips a date key", () => {
    expect(journalPathForDate("2026-08-07")).toBe("journals/2026-08-07.md");
    expect(journalDateFromPath("journals/2026-08-07.md")).toBe("2026-08-07");
  });

  it("rejects non-journal paths", () => {
    expect(journalDateFromPath("notes/2026-08-07.md")).toBeNull();
    expect(journalDateFromPath("journals/notes.md")).toBeNull();
    expect(journalDateFromPath("journals/2026-08-07.md.bak")).toBeNull();
  });
});

describe("journalDayLabel", () => {
  it("formats a long day label with the year", () => {
    const label = journalDayLabel("journals/2026-08-07.md", "2026-08-07");
    expect(label).toContain("2026");
    expect(label).not.toBe("2026-08-07");
  });

  it("falls back to a date-shaped title when the path has none", () => {
    const label = journalDayLabel("notes/misfiled.md", "2026-08-07");
    expect(label).toContain("2026");
    expect(label).not.toBe("2026-08-07");
  });

  it("falls back to the raw title when nothing parses", () => {
    expect(journalDayLabel("notes/misfiled.md", "Not A Date")).toBe(
      "Not A Date",
    );
  });
});

describe("nearestEntry", () => {
  const keys = ["2026-08-01", "2026-08-03", "2026-08-07"];

  it("skips gaps to the nearest older entry", () => {
    expect(nearestEntry(keys, "2026-08-07", -1)).toBe("2026-08-03");
    expect(nearestEntry(keys, "2026-08-02", -1)).toBe("2026-08-01");
  });

  it("skips gaps to the nearest newer entry", () => {
    expect(nearestEntry(keys, "2026-08-01", 1)).toBe("2026-08-03");
    expect(nearestEntry(keys, "2026-08-04", 1)).toBe("2026-08-07");
  });

  it("returns null at the edges", () => {
    expect(nearestEntry(keys, "2026-08-01", -1)).toBeNull();
    expect(nearestEntry(keys, "2026-08-07", 1)).toBeNull();
    expect(nearestEntry([], "2026-08-07", -1)).toBeNull();
  });
});

describe("fastiRows", () => {
  it("synthesizes calendar days newest-first with null paths for gaps", () => {
    const entries = [
      { path: "journals/2026-08-07.md", journal_date: "2026-08-07" },
      { path: "journals/2026-08-05.md", journal_date: "2026-08-05" },
    ];
    const rows = fastiRows(entries, "2026-08-07", 4);
    expect(rows).toEqual([
      { dateKey: "2026-08-07", path: "journals/2026-08-07.md" },
      { dateKey: "2026-08-06", path: null },
      { dateKey: "2026-08-05", path: "journals/2026-08-05.md" },
      { dateKey: "2026-08-04", path: null },
    ]);
  });
});

describe("shortDate / relativeDays", () => {
  it("renders d/m", () => {
    expect(shortDate("2026-08-07")).toBe("7/8");
  });

  it("renders relative day offsets", () => {
    expect(relativeDays("2026-08-07", "2026-08-07")).toBe("today");
    expect(relativeDays("2026-08-05", "2026-08-07")).toBe("2d");
    expect(relativeDays("2026-08-08", "2026-08-07")).toBe("—");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && bun run test src/lib/journal.test.ts`
Expected: FAIL — module `#/lib/journal` not found.

- [ ] **Step 3: Implement**

`ui/src/lib/journal.ts`:

```ts
import { isoAddDays, localDateKey, parseLocalDate } from "#/lib/time";

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const JOURNAL_PATH_RE = /^journals\/(\d{4}-\d{2}-\d{2})\.md$/;

export function journalPathForDate(dateKey: string): string {
  return `journals/${dateKey}.md`;
}

/** Deterministic path for today's journal — the editor binds here before the
 *  file exists (accepted coupling to the server-side vault layout; see the
 *  2026-08-06 journal-create-on-first-write design). */
export function todayJournalPath(): string {
  return journalPathForDate(localDateKey(new Date()));
}

export function journalDateFromPath(path: string): string | null {
  const m = path.match(JOURNAL_PATH_RE);
  return m ? m[1] : null;
}

/** FOLIO title for JOURNAL pages: "Friday 7 August 2026". Falls back to the
 *  raw title when neither path nor title carries a journal date. */
export function journalDayLabel(path: string, title: string): string {
  const dateKey =
    journalDateFromPath(path) ?? (DATE_KEY_RE.test(title) ? title : null);
  if (!dateKey) return title;
  return parseLocalDate(dateKey).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** Nearest written day strictly before (-1) or after (+1) `from`, or null.
 *  Date keys compare lexicographically. */
export function nearestEntry(
  writtenKeys: readonly string[],
  from: string,
  direction: -1 | 1,
): string | null {
  let best: string | null = null;
  for (const k of writtenKeys) {
    if (direction === -1 ? k >= from : k <= from) continue;
    if (best === null || (direction === -1 ? k > best : k < best)) best = k;
  }
  return best;
}

export type FastiRow = { dateKey: string; path: string | null };

/** The `count` most recent calendar days ending at `todayKey`, newest first,
 *  each resolved to its journal path or null for a skipped day. */
export function fastiRows(
  entries: readonly { path: string; journal_date: string }[],
  todayKey: string,
  count: number,
): FastiRow[] {
  const byDate = new Map(entries.map((e) => [e.journal_date, e.path]));
  return Array.from({ length: count }, (_, i) => {
    const dateKey = isoAddDays(todayKey, -i);
    return { dateKey, path: byDate.get(dateKey) ?? null };
  });
}

export function shortDate(dateKey: string): string {
  const d = parseLocalDate(dateKey);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

export function relativeDays(dateKey: string, todayKey: string): string {
  if (dateKey === todayKey) return "today";
  const ms =
    parseLocalDate(todayKey).getTime() - parseLocalDate(dateKey).getTime();
  const diff = Math.round(ms / 86_400_000);
  return diff > 0 ? `${diff}d` : "—";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && bun run test src/lib/journal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ui && bun run format
git add ui/src/lib/journal.ts ui/src/lib/journal.test.ts
git commit -m "feat(ui): pure journal path/nav/label helpers"
```

---

### Task 3: Read-only title — PageEditorHeader + kind presentation

**Files:**
- Modify: `ui/src/editor/PageEditorHeader.tsx`
- Modify: `ui/src/lib/kindPresentation.tsx`
- Modify: `ui/src/components/codex/Folio.tsx` (title row + presentation lookup)
- Test: `ui/src/editor/__tests__/PageEditorHeader.test.tsx` (create)

**Interfaces:**
- Consumes: `journalDayLabel` from Task 2.
- Produces:
  - `PageEditorHeader` accepts optional `readOnlyTitle?: string`; when set it renders a static `<h1>` instead of the title input (tags/aliases unchanged).
  - `KindPresentation` gains `readOnlyTitle?: (path: string, title: string) => string` and exports `KindMetaExtrasProps = { path: string; tabId: string; isDraft: boolean }` (the `metaExtras` component prop type — consumed by Tasks 4–5). Registry gains `JOURNAL: { metaExtras: null, readOnlyTitle: journalDayLabel }`.
  - `Folio` resolves `const presentation = presentationFor(kind);` once and passes `readOnlyTitle={presentation.readOnlyTitle?.(path, editor.title)}`.

- [ ] **Step 1: Write the failing test**

`ui/src/editor/__tests__/PageEditorHeader.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PageEditorHeader } from "#/editor/PageEditorHeader";

const baseProps = {
  path: "journals/2026-08-07.md",
  title: "2026-08-07",
  onTitleChange: vi.fn(),
  tags: [] as string[],
  onTagsChange: vi.fn(),
  aliases: [] as string[],
  onAliasesChange: vi.fn(),
};

describe("PageEditorHeader read-only title", () => {
  it("renders a static heading and no title input when readOnlyTitle is set", () => {
    render(
      <PageEditorHeader {...baseProps} readOnlyTitle="Friday 7 August 2026" />,
    );
    expect(
      screen.getByRole("heading", { name: "Friday 7 August 2026" }),
    ).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("2026-08-07.md")).toBeNull();
  });

  it("keeps the editable input when readOnlyTitle is absent", () => {
    const onTitleChange = vi.fn();
    render(<PageEditorHeader {...baseProps} onTitleChange={onTitleChange} />);
    const input = screen.getByDisplayValue("2026-08-07");
    fireEvent.change(input, { target: { value: "renamed" } });
    expect(onTitleChange).toHaveBeenCalledWith("renamed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bun run test src/editor/__tests__/PageEditorHeader.test.tsx`
Expected: FAIL — unknown prop / no heading rendered.

- [ ] **Step 3: Implement PageEditorHeader**

In `ui/src/editor/PageEditorHeader.tsx`, add to the props interface:

```ts
  /** When set, the title renders as this static text and cannot be edited
   *  (JOURNAL pages: the formatted day label). */
  readOnlyTitle?: string;
```

Destructure `readOnlyTitle` and replace the bare `<input …/>` with:

```tsx
      {readOnlyTitle !== undefined ? (
        <h1 className="w-full font-heading text-2xl font-bold">
          {readOnlyTitle}
        </h1>
      ) : (
        <input
          type="text"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          onBlur={onSaveNow}
          placeholder={filename(path)}
          className="w-full bg-transparent font-heading text-2xl font-bold outline-none placeholder:text-muted-foreground"
        />
      )}
```

- [ ] **Step 4: Extend the kind-presentation registry**

Replace the body of `ui/src/lib/kindPresentation.tsx` with:

```tsx
import type { ComponentType } from "react";
import { journalDayLabel } from "#/lib/journal";
import type { Kind } from "#/lib/kind";

/** Props FOLIO hands every bespoke META-rail block. */
export type KindMetaExtrasProps = {
  path: string;
  /** Workspace tab hosting this folio — lets a block repoint it (day nav). */
  tabId: string;
  /** True while the editor drafts a not-yet-created page (today's journal). */
  isDraft: boolean;
};

/** What a per-kind renderer may customise around the shared FOLIO editor. */
export type KindPresentation = {
  /** Extra META-rail block for this kind, or null for the generic surface. */
  metaExtras: ComponentType<KindMetaExtrasProps> | null;
  /** Label for FOLIO's wrapping Block around metaExtras (default "Details"). */
  metaExtrasLabel?: string;
  /** When set, FOLIO renders this string as a static title in place of the
   *  editable title input. */
  readOnlyTitle?: (path: string, title: string) => string;
};

const GENERIC: KindPresentation = { metaExtras: null };

/** Bespoke registry. JOURNAL's metaExtras lands with the JournalMeta block. */
const REGISTRY: Partial<Record<Kind, KindPresentation>> = {
  JOURNAL: { metaExtras: null, readOnlyTitle: journalDayLabel },
};

export function presentationFor(kind: Kind): KindPresentation {
  return REGISTRY[kind] ?? GENERIC;
}
```

- [ ] **Step 5: Wire Folio**

In `ui/src/components/codex/Folio.tsx`, after the `kind` memo (~line 122), add:

```ts
  const presentation = presentationFor(kind);
```

Change the metaExtras IIFE (~line 252) to use it (`const Extras = presentation.metaExtras;` — the `Block label="Details"` wrapper is unchanged in this task), and pass the title override in the dossier header (~line 297):

```tsx
              <PageEditorHeader
                path={path}
                title={editor.title}
                onTitleChange={editor.setTitle}
                readOnlyTitle={presentation.readOnlyTitle?.(path, editor.title)}
                tags={editor.tags}
                onTagsChange={editor.setTags}
                aliases={editor.aliases}
                onAliasesChange={editor.setAliases}
                onSaveNow={editor.saveNow}
              />
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd ui && bun run test src/editor/__tests__/PageEditorHeader.test.tsx && bun run typecheck`
Expected: PASS. (`KindMetaExtrasProps` is exported but unconsumed until Task 5 — `noUnusedLocals` does not flag exports.)

- [ ] **Step 7: Commit**

```bash
cd ui && bun run format
git add ui/src/editor/PageEditorHeader.tsx ui/src/editor/__tests__/PageEditorHeader.test.tsx ui/src/lib/kindPresentation.tsx ui/src/components/codex/Folio.tsx
git commit -m "feat(ui): read-only day-label title for JOURNAL folios"
```

---

### Task 4: FOLIO draft wiring — `useJournalEditorOptions`

**Files:**
- Modify: `ui/src/api/journal.ts`
- Modify: `ui/src/components/codex/Folio.tsx` (editor call + not-found gate)
- Modify: `ui/src/components/codex/__tests__/EditorConflictWiring.test.tsx` (mock only)
- Test: `ui/src/api/__tests__/journal.test.tsx` (extend)
- Test: `ui/src/components/codex/__tests__/FolioJournalDraft.test.tsx` (create)

**Interfaces:**
- Consumes: `useEnsureJournalToday` (existing), `todayJournalPath` (Task 2), `PageEditorOptions` type from `#/editor/usePageEditor`.
- Produces: `useJournalEditorOptions(path: string): PageEditorOptions | undefined` exported from `#/api/journal` — returns a stable `{ ensure }` when `path` is today's journal path, else `undefined`. Folio renders a draft (`editor.isDraft`) as an editable page rather than `FolioNotFound`.

- [ ] **Step 1: Write the failing hook tests**

Append to `ui/src/api/__tests__/journal.test.tsx` (reuse the file's existing `wrapper()` helper):

```tsx
describe("useJournalEditorOptions", () => {
  it("returns an ensure option for today's journal path", () => {
    const { result } = renderHook(
      () => useJournalEditorOptions(todayJournalPath()),
      { wrapper: wrapper() },
    );
    expect(result.current?.ensure).toBeTypeOf("function");
  });

  it("returns undefined for any other path", () => {
    const { result } = renderHook(
      () => useJournalEditorOptions("journals/1999-01-01.md"),
      { wrapper: wrapper() },
    );
    expect(result.current).toBeUndefined();
  });

  it("is referentially stable across rerenders", () => {
    const { result, rerender } = renderHook(
      () => useJournalEditorOptions(todayJournalPath()),
      { wrapper: wrapper() },
    );
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
```

Add imports at the top of the test file: `useJournalEditorOptions` from `../journal`, `todayJournalPath` from `#/lib/journal`.

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && bun run test src/api/__tests__/journal.test.tsx`
Expected: FAIL — `useJournalEditorOptions` is not exported.

- [ ] **Step 3: Implement the hook**

In `ui/src/api/journal.ts`, add (type-only import keeps the api→editor edge safe):

```ts
import { useMemo } from "react";
import type { PageEditorOptions } from "#/editor/usePageEditor";
import { todayJournalPath } from "#/lib/journal";

/** FOLIO's journal wiring: today's journal binds before the file exists and
 *  is created on first write; every other path edits normally. */
export function useJournalEditorOptions(
  path: string,
): PageEditorOptions | undefined {
  const ensureToday = useEnsureJournalToday();
  const mutateAsync = ensureToday.mutateAsync;
  const isToday = path === todayJournalPath();
  return useMemo(
    () => (isToday ? { ensure: () => mutateAsync() } : undefined),
    [isToday, mutateAsync],
  );
}
```

- [ ] **Step 4: Wire Folio and guard the not-found gate**

In `ui/src/components/codex/Folio.tsx`:

```ts
  const editor = usePageEditor(path, useJournalEditorOptions(path));
```

and change the error gate (~line 141) to:

```ts
  if (editor.error && !editor.isDraft) {
    return <FolioNotFound path={path} onClose={() => closeTab(tabId)} />;
  }
```

In `EditorConflictWiring.test.tsx`, add to the existing `vi.mock("#/api/journal", …)` factory:

```ts
  useJournalEditorOptions: () => undefined,
```

- [ ] **Step 5: Write the failing Folio draft test**

`ui/src/components/codex/__tests__/FolioJournalDraft.test.tsx` (mock harness modeled on `EditorConflictWiring.test.tsx`):

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { usePageEditorMock } = vi.hoisted(() => ({
  usePageEditorMock: vi.fn(),
}));
vi.mock("#/editor/usePageEditor", () => ({
  usePageEditor: usePageEditorMock,
}));
vi.mock("#/editor/SaveIndicator", () => ({ SaveIndicator: () => null }));
vi.mock("#/editor/PageEditorHeader", () => ({ PageEditorHeader: () => null }));
vi.mock("#/editor/SlateEditor", () => ({ SlateEditor: () => null }));
vi.mock("#/api/index", () => ({
  useBacklinks: () => ({ data: [] }),
  useOutlinks: () => ({ data: [] }),
  useSimilar: () => ({ data: [] }),
}));
vi.mock("#/api/pages", () => ({
  useAssignPage: () => ({ mutate: vi.fn() }),
}));
vi.mock("#/api/journal", () => ({
  useJournalEditorOptions: () => undefined,
  useJournalRecent: () => ({ data: [] }),
  useEnsureJournalToday: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("#/lib/useProjects", () => ({ useProjects: () => [] }));
vi.mock("#/components/codex/useCollapsibleRail", () => ({
  useCollapsibleRail: () => ({
    collapsed: true,
    width: 0,
    toggle: vi.fn(),
    onResizeStart: vi.fn(),
  }),
}));
vi.mock("#/components/codex/useScrollSpy", () => ({
  useScrollSpy: () => ({ activeIndex: -1, scrollTo: vi.fn() }),
}));

import { Folio } from "../Folio";

function draftEditor() {
  return {
    isLoading: false,
    error: { status: 404 },
    isDraft: true,
    initialValue: [{ type: "paragraph", children: [{ text: "" }] }],
    editorRevision: 0,
    title: "",
    setTitle: vi.fn(),
    tags: [],
    setTags: vi.fn(),
    aliases: [],
    setAliases: vi.fn(),
    saveStatus: "saved" as const,
    saveError: null,
    onSlateChange: vi.fn(),
    saveNow: vi.fn(),
    revisionConflict: null,
    reloadAfterConflict: vi.fn(),
    createdAt: null,
    updatedAt: null,
    bodyMarkdown: "",
    kind: null,
    inferred: true,
    project: null,
  };
}

describe("Folio journal draft", () => {
  it("renders the editor surface, not FolioNotFound, for a draft", () => {
    usePageEditorMock.mockReturnValue(draftEditor());
    render(<Folio tabId="t1" path="journals/2026-08-07.md" />);
    expect(screen.queryByText(/not found/i)).toBeNull();
    expect(screen.getByText(/END OF FILE/)).toBeInTheDocument();
  });

  it("still renders FolioNotFound for a plain missing page", () => {
    usePageEditorMock.mockReturnValue({
      ...draftEditor(),
      isDraft: false,
    });
    render(<Folio tabId="t1" path="notes/missing.md" />);
    expect(screen.queryByText(/END OF FILE/)).toBeNull();
  });
});
```

(Adjust the `FolioNotFound` assertion strings to that component's actual copy — check `FolioNotFound.tsx` when writing the test; the load-bearing assertions are "editor surface present for draft" and "absent for non-draft".)

- [ ] **Step 6: Run the new tests + full UI suite**

Run: `cd ui && bun run test src/components/codex/__tests__/FolioJournalDraft.test.tsx src/api/__tests__/journal.test.tsx && bun run test`
Expected: PASS (EditorConflictWiring keeps passing with the added mock export).

- [ ] **Step 7: Commit**

```bash
cd ui && bun run format
git add ui/src/api/journal.ts ui/src/api/__tests__/journal.test.tsx ui/src/components/codex/Folio.tsx ui/src/components/codex/__tests__/FolioJournalDraft.test.tsx ui/src/components/codex/__tests__/EditorConflictWiring.test.tsx
git commit -m "feat(ui): journal draft-first-write wiring in Folio"
```

---

### Task 5: `JournalMeta` META-rail block

**Files:**
- Create: `ui/src/components/codex/JournalMeta.tsx`
- Modify: `ui/src/lib/kindPresentation.tsx` (registry entry)
- Modify: `ui/src/components/codex/Folio.tsx` (extras props + block label)
- Test: `ui/src/components/codex/__tests__/JournalMeta.test.tsx` (create)

**Interfaces:**
- Consumes: `KindMetaExtrasProps` (Task 3); `fastiRows`, `nearestEntry`, `journalPathForDate`, `journalDateFromPath`, `shortDate`, `relativeDays` (Task 2); `useJournalRecent` (existing); `updateTabPath` from the workspace store; `dayOfYear`, `isLeapYear`, `localDateKey`, `parseLocalDate` from `#/lib/time`; `CircleDot`/`Circle` from `lucide-react`.
- Produces: `JournalMeta: ComponentType<KindMetaExtrasProps>`; registry entry `JOURNAL: { metaExtras: JournalMeta, metaExtrasLabel: "Journal", readOnlyTitle: journalDayLabel }`; Folio's extras wrapper renders `presentation.metaExtrasLabel ?? "Details"` and passes `tabId`/`isDraft`.

- [ ] **Step 1: Write the failing component tests**

`ui/src/components/codex/__tests__/JournalMeta.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { useJournalRecentMock, updateTabPathMock } = vi.hoisted(() => ({
  useJournalRecentMock: vi.fn(),
  updateTabPathMock: vi.fn(),
}));
vi.mock("#/api/journal", () => ({
  useJournalRecent: useJournalRecentMock,
}));
vi.mock("#/store/workspace", () => ({
  useWorkspaceStore: (sel: (s: unknown) => unknown) =>
    sel({ updateTabPath: updateTabPathMock }),
}));

import { JournalMeta } from "../JournalMeta";

const entry = (d: string) => ({
  id: d,
  path: `journals/${d}.md`,
  title: d,
  journal_date: d,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-07T12:00:00"));
  updateTabPathMock.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("JournalMeta", () => {
  it("prev skips gap days to the nearest written entry", () => {
    useJournalRecentMock.mockReturnValue({
      data: [entry("2026-08-07"), entry("2026-08-04")],
    });
    render(
      <JournalMeta path="journals/2026-08-07.md" tabId="t1" isDraft={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "previous entry" }));
    expect(updateTabPathMock).toHaveBeenCalledWith(
      "t1",
      "journals/2026-08-04.md",
      "2026-08-04",
    );
  });

  it("disables prev at the window edge and next on today", () => {
    useJournalRecentMock.mockReturnValue({ data: [entry("2026-08-07")] });
    render(
      <JournalMeta path="journals/2026-08-07.md" tabId="t1" isDraft={false} />,
    );
    expect(screen.getByRole("button", { name: "previous entry" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "next entry" })).toBeDisabled();
  });

  it("renders skipped days as non-interactive rows", () => {
    useJournalRecentMock.mockReturnValue({
      data: [entry("2026-08-07"), entry("2026-08-05")],
    });
    render(
      <JournalMeta path="journals/2026-08-07.md" tabId="t1" isDraft={false} />,
    );
    const skipped = screen.getByRole("button", { name: /6\/8/ });
    expect(skipped).toBeDisabled();
    const written = screen.getByRole("button", { name: /5\/8/ });
    fireEvent.click(written);
    expect(updateTabPathMock).toHaveBeenCalledWith(
      "t1",
      "journals/2026-08-05.md",
      "2026-08-05",
    );
  });

  it("shows unwritten state for a draft and day-of-year marginalia", () => {
    useJournalRecentMock.mockReturnValue({ data: [] });
    render(
      <JournalMeta path="journals/2026-08-07.md" tabId="t1" isDraft={true} />,
    );
    expect(screen.getByText("unwritten")).toBeInTheDocument();
    expect(screen.getByText("219 / 365")).toBeInTheDocument();
  });
});
```

(2026-08-07 is day 219 of a non-leap year; verify with `dayOfYear` if in doubt.)

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && bun run test src/components/codex/__tests__/JournalMeta.test.tsx`
Expected: FAIL — `../JournalMeta` does not exist.

- [ ] **Step 3: Implement JournalMeta**

`ui/src/components/codex/JournalMeta.tsx`:

```tsx
import { Circle, CircleDot } from "lucide-react";
import { useJournalRecent } from "#/api/journal";
import { cn } from "#/lib/cn";
import {
  fastiRows,
  journalDateFromPath,
  journalPathForDate,
  nearestEntry,
  relativeDays,
  shortDate,
} from "#/lib/journal";
import type { KindMetaExtrasProps } from "#/lib/kindPresentation";
import { dayOfYear, isLeapYear, localDateKey, parseLocalDate } from "#/lib/time";
import { useWorkspaceStore } from "#/store/workspace";

const FASTI_ROWS = 14;
const FETCH_DAYS = 30;

/** JOURNAL-kind META-rail block: day navigation over written entries, the
 *  FASTI recent timeline, and this-day marginalia. Day nav repoints the
 *  hosting tab in place (updateTabPath) — the same follow mechanism as
 *  kind/project assignment — rather than opening a tab per day. */
export function JournalMeta({ path, tabId, isDraft }: KindMetaExtrasProps) {
  const { data: recent } = useJournalRecent(FETCH_DAYS);
  const updateTabPath = useWorkspaceStore((s) => s.updateTabPath);

  const todayKey = localDateKey(new Date());
  const dateKey = journalDateFromPath(path) ?? todayKey;
  const entries = recent ?? [];
  // Today is always navigable: it can draft even before the file exists.
  const writtenKeys = [
    ...new Set([...entries.map((e) => e.journal_date), todayKey]),
  ];

  const goTo = (key: string) =>
    updateTabPath(tabId, journalPathForDate(key), key);

  const prevKey = nearestEntry(writtenKeys, dateKey, -1);
  const nextKey = nearestEntry(writtenKeys, dateKey, 1);
  const rows = fastiRows(entries, todayKey, FASTI_ROWS);
  const date = parseLocalDate(dateKey);
  const yearDays = isLeapYear(date.getFullYear()) ? 366 : 365;

  return (
    <div>
      <div className="flex gap-1">
        <button
          type="button"
          className="cl-btn"
          disabled={!prevKey}
          onClick={() => prevKey && goTo(prevKey)}
          aria-label="previous entry"
        >
          ‹
        </button>
        <button
          type="button"
          className="cl-btn"
          disabled={dateKey === todayKey}
          onClick={() => goTo(todayKey)}
        >
          Today
        </button>
        <button
          type="button"
          className="cl-btn"
          disabled={!nextKey}
          onClick={() => nextKey && goTo(nextKey)}
          aria-label="next entry"
        >
          ›
        </button>
      </div>

      <div className="mt-2 border-l border-rule pl-2">
        {rows.map((r) => {
          const active = r.dateKey === dateKey;
          const navigable = r.path !== null || r.dateKey === todayKey;
          return (
            <button
              key={r.dateKey}
              type="button"
              disabled={!navigable}
              onClick={() => navigable && goTo(r.dateKey)}
              className={cn(
                "grid w-full grid-cols-[auto_1fr_auto] items-baseline gap-[6px] py-[1px] text-left text-[10px]",
                active
                  ? "text-ink"
                  : navigable
                    ? "cursor-pointer text-ink-mute hover:text-ink"
                    : "text-ink-mute opacity-50",
              )}
            >
              {r.path !== null ? (
                <CircleDot size={10} className="text-accent" aria-hidden />
              ) : (
                <Circle size={10} aria-hidden />
              )}
              <span
                className={cn(
                  "cl-serif",
                  active ? "font-semibold not-italic" : "italic",
                )}
              >
                {shortDate(r.dateKey)}
              </span>
              <span className="cl-mono text-[9px]">
                {relativeDays(r.dateKey, todayKey)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="cl-mono mt-3 flex flex-col gap-1 text-[11px]">
        <div className="flex justify-between">
          <span className="text-[9px] uppercase tracking-[0.12em] text-ink-mute">
            Day
          </span>
          <span className="text-ink-2">
            {dayOfYear(date)} / {yearDays}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-[9px] uppercase tracking-[0.12em] text-ink-mute">
            State
          </span>
          <span className="text-ink-2">{isDraft ? "unwritten" : "written"}</span>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Register and re-wire Folio's extras slot**

In `ui/src/lib/kindPresentation.tsx`:

```ts
import { JournalMeta } from "#/components/codex/JournalMeta";
// …
const REGISTRY: Partial<Record<Kind, KindPresentation>> = {
  JOURNAL: {
    metaExtras: JournalMeta,
    metaExtrasLabel: "Journal",
    readOnlyTitle: journalDayLabel,
  },
};
```

In `ui/src/components/codex/Folio.tsx`, replace the extras IIFE with:

```tsx
          {(() => {
            const Extras = presentation.metaExtras;
            return Extras ? (
              <Block label={presentation.metaExtrasLabel ?? "Details"}>
                <Extras path={path} tabId={tabId} isDraft={editor.isDraft} />
              </Block>
            ) : null;
          })()}
```

- [ ] **Step 5: Run tests**

Run: `cd ui && bun run test src/components/codex/__tests__/JournalMeta.test.tsx && bun run test && bun run typecheck`
Expected: PASS. If `EditorConflictWiring`/`FolioJournalDraft` fail because Folio's tree now mounts `JournalMeta` for JOURNAL paths, their `#/api/journal` mocks already export `useJournalRecent` — confirm the mock returns `{ data: [] }`.

- [ ] **Step 6: Commit**

```bash
cd ui && bun run format
git add ui/src/components/codex/JournalMeta.tsx ui/src/components/codex/__tests__/JournalMeta.test.tsx ui/src/lib/kindPresentation.tsx ui/src/components/codex/Folio.tsx
git commit -m "feat(ui): JournalMeta day-nav/FASTI block in the folio META rail"
```

---

### Task 6: Open-today action + entry points (shortcut, palette, Atrium, launcher)

**Files:**
- Create: `ui/src/hooks/useOpenTodayJournal.ts`
- Modify: `ui/src/lib/shortcuts.ts` (rename `nav.diurnal` → `journal.today`)
- Modify: `ui/src/hooks/useGlobalShortcuts.tsx`
- Modify: `ui/src/components/codex/CommandPalette.tsx`
- Modify: `ui/src/components/codex/Atrium.tsx`
- Modify: `ui/src/components/codex/FolioLauncher.tsx`
- Test: `ui/src/hooks/useOpenTodayJournal.test.tsx` (create); extend `ui/src/components/codex/__tests__/FolioLauncher.test.tsx` and `__tests__/CommandPalette.test.tsx`

**Interfaces:**
- Consumes: `useOpenTab` (already navigates to `/workspace`), `todayJournalPath`/`journalDateFromPath` (Task 2).
- Produces: `useOpenTodayJournal(): () => void` — opens/focuses the tab for today's journal. Registry id `journal.today` (chord `{ key: "d", mod: true, shift: false }` — `shift: false` is REQUIRED: `matchesChord` skips the shift check for letter chords that leave `shift` undefined, and Task 7 adds ⌘⇧D).

- [ ] **Step 1: Write the failing hook test**

`ui/src/hooks/useOpenTodayJournal.test.tsx`:

```tsx
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { openTabMock } = vi.hoisted(() => ({ openTabMock: vi.fn() }));
vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
}));

import { todayJournalPath } from "#/lib/journal";
import { useOpenTodayJournal } from "#/hooks/useOpenTodayJournal";

describe("useOpenTodayJournal", () => {
  it("opens today's journal as a page tab labelled with the date key", () => {
    const { result } = renderHook(() => useOpenTodayJournal());
    result.current();
    const path = todayJournalPath();
    const dateKey = path.slice("journals/".length, -".md".length);
    expect(openTabMock).toHaveBeenCalledWith("page", path, dateKey);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && bun run test src/hooks/useOpenTodayJournal.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

`ui/src/hooks/useOpenTodayJournal.ts`:

```ts
import { useCallback } from "react";
import { useOpenTab } from "#/hooks/useOpenTab";
import { journalDateFromPath, todayJournalPath } from "#/lib/journal";

/** Open (or focus) today's journal as a workspace folio tab. The tab label
 *  starts as the date key; FOLIO's title-driven updateTabLabel takes over
 *  once the page loads. */
export function useOpenTodayJournal(): () => void {
  const openTab = useOpenTab();
  return useCallback(() => {
    const path = todayJournalPath();
    openTab("page", path, journalDateFromPath(path) ?? "today");
  }, [openTab]);
}
```

- [ ] **Step 4: Rename the registry entry and rewire all four entry points**

`ui/src/lib/shortcuts.ts` — replace the `nav.diurnal` entry in place:

```ts
  "journal.today": {
    chord: { key: "d", mod: true, shift: false },
    label: "Today's journal",
    group: "Navigate",
    scope: "global",
    note: "outside the editor",
  },
```

`ui/src/hooks/useGlobalShortcuts.tsx` — replace the `nav.diurnal` binding (the `Record<GlobalShortcutId, Binding>` is exhaustive, so the compiler walks you to every required change):

```ts
      "journal.today": { run: openTodayJournal },
```

with `const openTodayJournal = useOpenTodayJournal();` added beside the other hooks and to the memo deps.

`ui/src/components/codex/CommandPalette.tsx` — replace the Diurnal command:

```ts
      {
        kind: "cmd",
        id: formatChord(SHORTCUTS["journal.today"].chord),
        title: "Today's journal",
        action: () => openTodayJournal(),
      },
```

with `const openTodayJournal = useOpenTodayJournal();` beside the other hooks (add it to the `verbCommands` memo deps).

`ui/src/components/codex/Atrium.tsx` — the journal CTA button's `onClick={() => navigate({ to: "/journal" })}` becomes `onClick={openTodayJournal}` with `const openTodayJournal = useOpenTodayJournal();`.

`ui/src/components/codex/FolioLauncher.tsx` — add after the "Inscribe new folio" action:

```tsx
            <LauncherAction
              label="Today's journal"
              hint="⌘D"
              onClick={openTodayJournal}
            />
```

with `const openTodayJournal = useOpenTodayJournal();`.

- [ ] **Step 5: Extend launcher/palette tests**

In `__tests__/FolioLauncher.test.tsx`, add a test (follow the file's existing mock pattern for `useOpenTab`/stores):

```tsx
  it("opens today's journal from the launcher", () => {
    // render FolioLauncher via the file's existing harness
    fireEvent.click(screen.getByText("Today's journal"));
    // assert against the file's openTab mock:
    expect(openTabMock).toHaveBeenCalledWith(
      "page",
      todayJournalPath(),
      expect.any(String),
    );
  });
```

In `__tests__/CommandPalette.test.tsx`, add assertions that the command list contains "Today's journal" and not "Open Diurnal" (follow that file's existing render/query pattern).

- [ ] **Step 6: Run the UI suite + typecheck**

Run: `cd ui && bun run test && bun run typecheck`
Expected: PASS. The compiler enforces that no `nav.diurnal` reference survives.

- [ ] **Step 7: Commit**

```bash
cd ui && bun run format
git add -A ui/src
git commit -m "feat(ui): today's-journal entry points (⌘D, palette, Atrium, launcher)"
```

---

### Task 7: Capture aside — store, modal, palette command, ⌘⇧D

**Files:**
- Modify: `ui/src/store/ui.ts`
- Create: `ui/src/components/codex/CaptureAsideModal.tsx`
- Modify: `ui/src/routes/__root.tsx` (mount)
- Modify: `ui/src/lib/shortcuts.ts` (+ `journal.capture`)
- Modify: `ui/src/hooks/useGlobalShortcuts.tsx` (+ binding)
- Modify: `ui/src/components/codex/CommandPalette.tsx` (+ command)
- Test: `ui/src/components/codex/__tests__/CaptureAsideModal.test.tsx` (create)

**Interfaces:**
- Consumes: `useQuickCapture` (existing — POSTs `/journal/today/capture`), `CodexModalShell` (existing modal chrome), ui-store pattern from InscribeModal.
- Produces: ui-store fields `isCaptureAsideOpen: boolean`, `openCaptureAside: () => void`, `closeCaptureAside: () => void`; component `CaptureAsideModal`; registry id `journal.capture` with chord `{ key: "d", mod: true, shift: true }`.

- [ ] **Step 1: Write the failing modal tests**

`ui/src/components/codex/__tests__/CaptureAsideModal.test.tsx`. IMPORTANT (per project testing conventions): mock `useQuickCapture` with a fresh result object per call — TanStack mutation results are referentially unstable; only `.mutate` should be a stable spy.

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mutateMock } = vi.hoisted(() => ({ mutateMock: vi.fn() }));
vi.mock("#/api/journal", () => ({
  useQuickCapture: () => ({ mutate: mutateMock, isPending: false }),
}));

import { CaptureAsideModal } from "../CaptureAsideModal";
import { useUiStore } from "#/store/ui";

beforeEach(() => {
  mutateMock.mockReset();
  useUiStore.getState().openCaptureAside();
});

describe("CaptureAsideModal", () => {
  it("submits trimmed content and closes on success", () => {
    mutateMock.mockImplementation((_content, opts) => opts?.onSuccess?.());
    render(<CaptureAsideModal />);
    fireEvent.change(screen.getByLabelText("Aside"), {
      target: { value: "  a thought  " },
    });
    fireEvent.submit(screen.getByLabelText("Aside").closest("form")!);
    expect(mutateMock).toHaveBeenCalledWith("a thought", expect.anything());
    expect(useUiStore.getState().isCaptureAsideOpen).toBe(false);
  });

  it("shows the error inline and stays open on failure", () => {
    mutateMock.mockImplementation((_content, opts) =>
      opts?.onError?.(new Error("Capture failed")),
    );
    render(<CaptureAsideModal />);
    fireEvent.change(screen.getByLabelText("Aside"), {
      target: { value: "x" },
    });
    fireEvent.submit(screen.getByLabelText("Aside").closest("form")!);
    expect(screen.getByText(/Capture failed/)).toBeInTheDocument();
    expect(useUiStore.getState().isCaptureAsideOpen).toBe(true);
  });

  it("renders nothing when closed", () => {
    useUiStore.getState().closeCaptureAside();
    render(<CaptureAsideModal />);
    expect(screen.queryByLabelText("Aside")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && bun run test src/components/codex/__tests__/CaptureAsideModal.test.tsx`
Expected: FAIL — `openCaptureAside` missing from the store / component missing.

- [ ] **Step 3: Implement store + modal**

`ui/src/store/ui.ts` — mirror the inscribe trio exactly:

```ts
  isCaptureAsideOpen: boolean;          // in the state interface
  openCaptureAside: () => void;         // in the actions interface
  closeCaptureAside: () => void;
  // …
  isCaptureAsideOpen: false,            // initial state
  openCaptureAside: () => set({ isCaptureAsideOpen: true }),
  closeCaptureAside: () => set({ isCaptureAsideOpen: false }),
```

`ui/src/components/codex/CaptureAsideModal.tsx`:

```tsx
import { type FormEvent, useState } from "react";
import { useQuickCapture } from "#/api/journal";
import { CodexModalShell } from "#/components/codex/CodexModalShell";
import { useUiStore } from "#/store/ui";

/** One-line aside capture — appends a time-stamped entry to today's journal
 *  from anywhere (⌘⇧D / palette). The server stamps plain prose and creates
 *  the journal if it does not exist yet. */
export function CaptureAsideModal() {
  const isOpen = useUiStore((s) => s.isCaptureAsideOpen);
  const onClose = useUiStore((s) => s.closeCaptureAside);
  const capture = useQuickCapture();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const dismiss = () => {
    setText("");
    setError(null);
    onClose();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const content = text.trim();
    if (!content) return;
    setError(null);
    capture.mutate(content, {
      onSuccess: dismiss,
      onError: (err) => setError(err.message),
    });
  };

  return (
    <CodexModalShell
      ariaLabel="Capture aside"
      maxWidthClassName="max-w-[440px]"
      onDismiss={dismiss}
    >
      <form onSubmit={submit}>
        <div className="flex items-baseline justify-between border-b border-ink bg-paper-2 px-3 py-1.5">
          <span className="cl-mono text-[10px] uppercase tracking-[0.18em] text-ink">
            ❦ Aside
          </span>
          <span className="cl-mono text-[9px] uppercase tracking-[0.14em] text-ink-mute">
            TODAY'S JOURNAL
          </span>
        </div>
        <div className="px-4 py-3">
          <input
            aria-label="Aside"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
            placeholder="capture an aside …"
            className="cl-mono w-full border border-rule bg-transparent p-1.5 text-[12px] text-ink outline-none placeholder:text-ink-mute focus:border-accent"
          />
          {error && (
            <div className="cl-mono mt-2 text-[11px] text-hot">⁂ {error}</div>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" className="cl-btn" onClick={dismiss}>
              cancel
            </button>
            <button
              type="submit"
              className="cl-btn cl-btn-hot"
              disabled={capture.isPending || !text.trim()}
            >
              {capture.isPending ? "noting…" : "❦ note"}
            </button>
          </div>
        </div>
      </form>
    </CodexModalShell>
  );
}
```

(Check `CodexModalShell`'s actual prop names against `InscribeModal`'s usage — `ariaLabel`, `maxWidthClassName`, `onDismiss` — and match them.)

- [ ] **Step 4: Mount + shortcut + palette**

`ui/src/routes/__root.tsx` — render `<CaptureAsideModal />` beside `<InscribeModal />`.

`ui/src/lib/shortcuts.ts` — add near `app.inscribe`:

```ts
  "journal.capture": {
    chord: { key: "d", mod: true, shift: true },
    label: "Capture aside",
    group: "Workspace",
    scope: "global",
    note: "appends to today's journal",
  },
```

`ui/src/hooks/useGlobalShortcuts.tsx` — the exhaustive record forces the new binding:

```ts
      "journal.capture": { run: openCaptureAside },
```

with `const openCaptureAside = useUiStore((s) => s.openCaptureAside);` and the memo dep.

`ui/src/components/codex/CommandPalette.tsx` — add after the "Today's journal" command:

```ts
      {
        kind: "cmd",
        id: formatChord(SHORTCUTS["journal.capture"].chord),
        title: "Capture aside",
        action: () => openCaptureAside(),
      },
```

with `const openCaptureAside = useUiStore((s) => s.openCaptureAside);` and the memo dep.

- [ ] **Step 5: Run suite**

Run: `cd ui && bun run test && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd ui && bun run format
git add -A ui/src
git commit -m "feat(ui): global capture-aside prompt (⌘⇧D, palette)"
```

---

### Task 8: Retire Diurnal — delete view, route, nav entry, dead API hook

**Files:**
- Delete: `ui/src/components/codex/Diurnal.tsx`, `ui/src/components/codex/__tests__/Diurnal.test.tsx`, `ui/src/routes/journal.tsx`
- Modify: `ui/src/components/codex/CodexFrame.tsx`
- Modify: `ui/src/api/journal.ts` (delete `useJournalByDate`)
- Modify: `ui/src/components/codex/__tests__/EditorConflictWiring.test.tsx` (drop the Diurnal half)
- Regenerate: `ui/src/routeTree.gen.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–7 (all journal entry points must already work — this task only removes).
- Produces: a five-entry NAV; no `/journal` route; no `useJournalByDate` export.

- [ ] **Step 1: Delete the view and route**

```bash
git rm ui/src/components/codex/Diurnal.tsx ui/src/components/codex/__tests__/Diurnal.test.tsx ui/src/routes/journal.tsx
```

- [ ] **Step 2: Excise "diurnal" from CodexFrame**

In `ui/src/components/codex/CodexFrame.tsx`:
- `View` union: remove `| "diurnal"`.
- `NAV`: remove the `["diurnal", "DIURNAL"]` row.
- View detection memo: remove `if (p.startsWith("/journal")) return "diurnal";`.
- `onNav`: remove `else if (target === "diurnal") navigate({ to: "/journal" });`.
- `useFolioCode`: remove `if (view === "diurnal") return "DIURNAL";`.

- [ ] **Step 3: Delete `useJournalByDate` and retarget the conflict-wiring test**

- In `ui/src/api/journal.ts`: delete the `useJournalByDate` function. If `ui/src/api/keys.ts` defines `journal.byDate` solely for it, delete that key too (check with `rg -n "byDate" ui/src`).
- In `ui/src/api/__tests__/journal.test.tsx`: delete any `useJournalByDate` describe block and import.
- In `__tests__/EditorConflictWiring.test.tsx`: remove the `import { Diurnal }` line and every Diurnal-rendering test; prune the `#/api/journal` mock to exactly the exports Folio's tree still consumes (`useJournalRecent`, `useEnsureJournalToday`, `useJournalEditorOptions`); keep the Folio tests unchanged.

- [ ] **Step 4: Regenerate the route tree**

```bash
cd ui && bunx @tanstack/router-cli generate
```

If `bunx` cannot resolve the CLI, fall back to letting the vite plugin regenerate: run `cd ui && bun run dev` in the background (`run_in_background`), wait a few seconds for vite to boot, then stop it. Either way, confirm `git diff --stat ui/src/routeTree.gen.ts` shows the journal route removed. Never hand-edit the file.

- [ ] **Step 5: Sweep for stragglers**

```bash
rg -in "diurnal" ui/src
rg -n "to: \"/journal\"" ui/src
rg -n "useJournalByDate" ui/src
```

Expected: zero hits each (route-tree file included). Fix any stragglers.

- [ ] **Step 6: Full UI suite + typecheck + knip**

Run: `cd ui && bun run test && bun run typecheck && bun run knip`
Expected: PASS; knip reports no new unused exports (it should confirm `useJournalByDate`'s removal rather than flag leftovers).

- [ ] **Step 7: Commit**

```bash
cd ui && bun run format
git add -A ui
git commit -m "feat(ui)!: retire the Diurnal view — journals are folio tabs"
```

---

### Task 9: Verification gates and merge readiness

**Files:** none (verification only)

- [ ] **Step 1: Frontend gates**

Run, from `ui/`: `bun run typecheck`, `bun run lint`, `bun run test`, `bun run knip`.
Expected: all clean. Report each result explicitly.

- [ ] **Step 2: Backend gates**

Run: `cargo fmt --check`, `cargo clippy --all-targets`, `cargo test`.
Expected: all clean. Report each result explicitly.

- [ ] **Step 3: Manual smoke (optional but recommended)**

`cargo run -- serve` + `cd ui && bun run dev`: ⌘D opens today's journal as a folio tab with a sans-serif body, read-only day-label title, "Journal" META block with lucide FASTI markers; Sheaf shows/highlights the journal tab; ⌘⇧D captures an aside that lands stamped (`- HH:MM — …`); no DIURNAL nav entry; `/journal` 404s into the SPA shell.

- [ ] **Step 4: Finish the branch**

Use superpowers:finishing-a-development-branch — merge `feature/diurnal-folio-unification` into `develop`, clean up the worktree.
