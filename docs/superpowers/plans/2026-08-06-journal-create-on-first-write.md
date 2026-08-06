# Journal Create-on-First-Write Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Today's journal file is created only on the first actual write (editor edit or quick capture), never as a side effect of rendering the Atrium or the journal view.

**Architecture:** `GET /journal/today` becomes a pure read (404 when absent); a new `POST /journal/today` carries the get-or-create semantics using the existing `ensure_journal` (template stays server-side). The frontend editor hook `usePageEditor` gains a draft mode: on a 404 load with an `ensure` callback it renders an empty editable document, and the first save calls ensure before the normal revision-checked update. Diurnal binds today's editor directly to `journals/<date>.md`; Atrium's journal query treats 404 as null.

**Tech Stack:** Rust (Axum 0.8, axum-test), React 19 + TanStack Query, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-08-06-journal-create-on-first-write-design.md`

## Global Constraints

- Work on branch `feature/journal-first-write` off `develop` (isolate via superpowers:using-git-worktrees at execution start).
- Backend verification: `cargo test`, `cargo clippy --all-targets`, `cargo fmt`. Frontend: `bun --cwd ui run typecheck`, `bun --cwd ui run lint`, `bun --cwd ui run test`.
- Journal routes carry **no** utoipa annotations (existing module style); do NOT regenerate `ui/src/api/schema.d.ts` — journal endpoints are not in the OpenAPI spec and `ui/src/api/journal.ts` uses raw `fetch`.
- The journal template (title = `YYYY-MM-DD`, `tags: ["journal"]`, empty body) is defined ONLY in `ensure_journal` (`src/api/journal.rs`). Never duplicate it client-side.
- Path alias `#/` = `ui/src/`. Biome formatting (2-space, double quotes). Never `cd` into the repo root; run cargo from the root and use `bun --cwd ui …` for frontend commands.

---

### Task 1: Backend — read-only GET /journal/today + POST ensure endpoint

**Files:**
- Modify: `src/api/journal.rs` (router at ~line 69, `get_today` at ~line 149)
- Test: `tests/api_journal_test.rs`
- Modify: `tests/e2e_tasks_journal_test.rs:162`, `tests/api_test.rs:944` (call sites that relied on GET auto-create)

**Interfaces:**
- Consumes: existing `ensure_journal(&state, &date) -> Result<(VaultPath, bool), ApiError>` (the bool is "newly created"), existing `page_detail(page) -> PageDetail`.
- Produces: `GET /api/vault/journal/today` → 200 `JournalTodayResponse` (unchanged shape, `PageDetail` flattened + `carried_forward`) or 404 `ApiError`. `POST /api/vault/journal/today` (no request body) → 201 `PageDetail` when created, 200 `PageDetail` when it already existed. Later tasks rely on: 404 body has an `error` string field; `PageDetail` JSON includes `path`, `revision`, `body`, `meta.{id,title,tags,aliases}`.

- [ ] **Step 1: Rewrite the contract tests in `tests/api_journal_test.rs`**

Replace the two tests in the `// GET /journal/today` section (`get_today_creates_journal_if_missing` at lines 151–169 and `get_today_returns_existing_journal` at lines 171–186) with:

```rust
#[tokio::test]
async fn get_today_returns_404_when_missing() {
    let (server, _tmp) = setup_server();
    let res = server.get("/api/vault/journal/today").await;
    res.assert_status(StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn get_today_does_not_create_journal() {
    let (server, _tmp) = setup_server();
    let res = server.get("/api/vault/journal/today").await;
    res.assert_status(StatusCode::NOT_FOUND);

    // get_by_date checks the filesystem directly, so a 404 here proves no
    // file was written; recent must stay empty for the same reason.
    let by_date = server
        .get(&format!("/api/vault/journal/{}", today_str()))
        .await;
    by_date.assert_status(StatusCode::NOT_FOUND);

    let recent: serde_json::Value = server.get("/api/vault/journal/recent").await.json();
    assert!(
        recent.as_array().unwrap().is_empty(),
        "GET /journal/today must not create a journal"
    );
}

#[tokio::test]
async fn get_today_reads_existing_journal() {
    let (server, _tmp) = setup_server();
    let created = server.post("/api/vault/journal/today").await;
    created.assert_status(StatusCode::CREATED);
    let created_body: serde_json::Value = created.json();
    let id = created_body["meta"]["id"].as_str().unwrap().to_string();

    let res = server.get("/api/vault/journal/today").await;
    res.assert_status_ok();
    let body: serde_json::Value = res.json();
    assert_eq!(body["meta"]["id"].as_str().unwrap(), id);
}
```

Add a new section after it:

```rust
// ---------------------------------------------------------------------------
// POST /journal/today
// ---------------------------------------------------------------------------

#[tokio::test]
async fn post_today_creates_with_template() {
    let (server, _tmp) = setup_server();
    let res = server.post("/api/vault/journal/today").await;
    res.assert_status(StatusCode::CREATED);
    let body: serde_json::Value = res.json();
    assert_eq!(
        body["path"].as_str().unwrap(),
        format!("journals/{}.md", today_str())
    );
    assert_eq!(body["meta"]["title"].as_str().unwrap(), today_str());
    assert!(
        body["meta"]["tags"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t == "journal")
    );
    assert_eq!(body["body"].as_str().unwrap(), "");
    assert!(body["revision"].as_str().is_some());
}

#[tokio::test]
async fn post_today_returns_existing_without_overwrite() {
    let (server, _tmp) = setup_server();
    let first = server.post("/api/vault/journal/today").await;
    first.assert_status(StatusCode::CREATED);
    let first_body: serde_json::Value = first.json();
    let first_id = first_body["meta"]["id"].as_str().unwrap().to_string();

    server
        .post("/api/vault/journal/today/capture")
        .json(&serde_json::json!({ "content": "Existing content" }))
        .await
        .assert_status_ok();

    let second = server.post("/api/vault/journal/today").await;
    second.assert_status_ok(); // 200, not 201
    let second_body: serde_json::Value = second.json();
    assert_eq!(second_body["meta"]["id"].as_str().unwrap(), first_id);
    assert!(
        second_body["body"]
            .as_str()
            .unwrap()
            .contains("Existing content"),
        "POST must not overwrite an existing journal"
    );
}
```

- [ ] **Step 2: Update creation-device call sites in `tests/api_journal_test.rs`**

Every test that used `GET /journal/today` merely to create the page switches to POST. Replace the line `server.get("/api/vault/journal/today").await` (with its surrounding call chain) at each of these sites:

In `mutation_creation_emits_exact_coordinator_notification` (~line 73):

```rust
    server
        .post("/api/vault/journal/today")
        .await
        .assert_status(StatusCode::CREATED);
```

In `get_by_date_returns_existing` (~line 197), `capture_appends_to_today` (~line 233, the *first* GET only — the verification GET at ~line 243 stays), `recent_returns_last_n_days` (~line 295), `recent_defaults_to_7_days` (~line 312), and `range_returns_journals_in_date_range` (~line 331), replace the create call with:

```rust
    server.post("/api/vault/journal/today").await;
```

In `today_journal_includes_carried_forward_tasks` (~line 396) and `today_journal_carried_forward_empty_when_no_recent_tasks` (~line 437), insert a POST immediately before the existing `server.get("/api/vault/journal/today")` (today's page must now exist before a GET can include `carried_forward`):

```rust
    server.post("/api/vault/journal/today").await;
```

- [ ] **Step 3: Run the journal tests to verify the new ones fail**

Run: `cargo test --test api_journal_test`
Expected: FAIL — `get_today_returns_404_when_missing`, `get_today_does_not_create_journal` fail (GET still creates and returns 200) and the POST tests fail with 405 Method Not Allowed (route doesn't exist yet).

- [ ] **Step 4: Implement in `src/api/journal.rs`**

Router (line ~69–76) — add POST to the `/today` route:

```rust
pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/today", get(get_today).post(ensure_today))
        .route("/today/capture", post(capture_today))
        .route("/range", get(get_range))
        .route("/recent", get(get_recent))
        .route("/{date}", get(get_by_date))
}
```

`get_today` (line ~143): replace the doc comment's first line and the ensure call. The function head becomes:

```rust
/// GET /journal/today — read today's journal page (404 when absent).
///
/// The response includes a `carried_forward` array of incomplete tasks from
/// journal pages in the past 7 days (excluding today). These tasks are not
/// copied into today's file — they are surfaced in the API response for the
/// UI to render.
async fn get_today(
    State(state): State<Arc<AppState>>,
) -> Result<Json<JournalTodayResponse>, ApiError> {
    let date = state.clock.now().format("%Y-%m-%d").to_string();
    let vault_path = journal_path(&date)?;
    let abs_path = state.vault.resolve(&vault_path);
    if !abs_path.exists() {
        return Err(ApiError::not_found(format!("journal not found: {date}")));
    }

    let page = Page::from_file(&abs_path, vault_path)
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;
```

(The old `let (vault_path, _created) = ensure_journal(&state, &date).await?;` and the second `let abs_path = state.vault.resolve(&vault_path);` are removed; everything from `let detail = page_detail(page);` on is unchanged.)

New handler, placed directly after `get_today`:

```rust
/// POST /journal/today — create today's journal if missing (get-or-create).
///
/// Returns 201 with the page when it was created, 200 when it already
/// existed. The journal template (title = date, `journal` tag) lives in
/// `ensure_journal` and nowhere else.
async fn ensure_today(State(state): State<Arc<AppState>>) -> Result<Response, ApiError> {
    let date = state.clock.now().format("%Y-%m-%d").to_string();
    let (vault_path, created) = ensure_journal(&state, &date).await?;

    let abs_path = state.vault.resolve(&vault_path);
    let page = Page::from_file(&abs_path, vault_path)
        .map_err(|e| ApiError::internal(format!("failed to read page: {e}")))?;

    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(page_detail(page))).into_response())
}
```

All needed imports (`Response`, `IntoResponse`, `StatusCode`, `post`) are already present in the file.

- [ ] **Step 5: Run the journal tests to verify they pass**

Run: `cargo test --test api_journal_test`
Expected: PASS (all tests).

- [ ] **Step 6: Fix the two other test files that relied on GET auto-create**

`tests/e2e_tasks_journal_test.rs` — at line ~162, immediately before `let res = server.get("/api/vault/journal/today").await;` (Step 5 of that test), insert:

```rust
    // Today's journal must exist before GET can return carried_forward.
    server.post("/api/vault/journal/today").await;
```

`tests/api_test.rs` — at line ~944, replace `let response = server.get("/api/vault/journal/today").await;` and its `response.assert_status_ok();` with:

```rust
    let response = server.post("/api/vault/journal/today").await;
    response.assert_status(StatusCode::CREATED);
    let response = server.get("/api/vault/journal/today").await;
    response.assert_status_ok();
```

- [ ] **Step 7: Run the full backend suite**

Run: `cargo test`
Expected: PASS. If any other test fails on a journal 404, it was relying on the removed auto-create — fix it the same way (POST before GET), and note the file in the commit message.

- [ ] **Step 8: Format, lint, commit**

```bash
cargo fmt
cargo clippy --all-targets
git add src/api/journal.rs tests/api_journal_test.rs tests/e2e_tasks_journal_test.rs tests/api_test.rs
git commit -m "feat(api): make GET /journal/today read-only, add POST /journal/today ensure"
```

---

### Task 2: Frontend API layer — nullable today query + ensure mutation

**Files:**
- Modify: `ui/src/api/journal.ts`
- Test: `ui/src/api/__tests__/journal.test.tsx` (create; the directory does not exist yet)

**Interfaces:**
- Consumes: Task 1's endpoints (`GET /api/vault/journal/today` → 200 | 404; `POST /api/vault/journal/today` → 201 | 200 with `PageDetail` JSON).
- Produces: `JournalDetail` gains `revision: string`. `useJournalToday(): UseQueryResult<JournalDetail | null>` (404 → `null`, other failures throw). New `useEnsureJournalToday(): UseMutationResult<EnsureJournalResult, Error, void>` where `interface EnsureJournalResult { page: JournalDetail; created: boolean }`. Task 4 calls `mutateAsync()` with no arguments.

- [ ] **Step 1: Write the failing tests**

Create `ui/src/api/__tests__/journal.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEnsureJournalToday, useJournalToday } from "../journal";

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const page = {
  path: "journals/2026-08-06.md",
  canonical_name: "2026-08-06",
  revision: "rev-a",
  body: "",
  meta: { id: "019fc7fc-5ceb-7cd1-a312-e03266ff3f62", title: "2026-08-06" },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useJournalToday", () => {
  it("resolves to null when today's journal does not exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(404, { error: "journal not found" })),
    );
    const { result } = renderHook(() => useJournalToday(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it("resolves to the page when it exists", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, page)));
    const { result } = renderHook(() => useJournalToday(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.meta.id).toBe(page.meta.id);
  });

  it("errors on non-404 failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" })),
    );
    const { result } = renderHook(() => useJournalToday(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useEnsureJournalToday", () => {
  it("POSTs and reports created=true on 201", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, page));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useEnsureJournalToday(), {
      wrapper: wrapper(),
    });
    const out = await result.current.mutateAsync();
    expect(out.created).toBe(true);
    expect(out.page.path).toBe("journals/2026-08-06.md");
    expect(fetchMock).toHaveBeenCalledWith("/api/vault/journal/today", {
      method: "POST",
    });
  });

  it("reports created=false on 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, page)));
    const { result } = renderHook(() => useEnsureJournalToday(), {
      wrapper: wrapper(),
    });
    const out = await result.current.mutateAsync();
    expect(out.created).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --cwd ui run test src/api/__tests__/journal.test.tsx`
Expected: FAIL — `useEnsureJournalToday` is not exported; the null-on-404 test fails because the current hook throws.

- [ ] **Step 3: Implement in `ui/src/api/journal.ts`**

Add `revision` to the interface (after `canonical_name`):

```ts
export interface JournalDetail {
  path: string;
  canonical_name: string;
  revision: string;
  meta: {
    id: string;
    title?: string | null;
    tags?: string[] | null;
    aliases?: string[] | null;
    created_at?: string | null;
    updated_at?: string | null;
  };
  body: string;
}
```

Replace `useJournalToday` and add the ensure mutation directly below it:

```ts
export function useJournalToday() {
  return useQuery<JournalDetail | null>({
    queryKey: queryKeys.journal.today,
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/today`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to fetch journal");
      return res.json();
    },
  });
}

export interface EnsureJournalResult {
  page: JournalDetail;
  created: boolean;
}

/**
 * POST /journal/today — create today's journal if missing (get-or-create).
 * The journal template lives server-side; `created` distinguishes 201 from
 * 200 so the editor can detect a concurrently-written page.
 */
export function useEnsureJournalToday() {
  const qc = useQueryClient();
  return useMutation<EnsureJournalResult, Error, void>({
    mutationFn: async () => {
      const res = await fetch(`${API_BASE}/today`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to create today's journal");
      const page = (await res.json()) as JournalDetail;
      return { page, created: res.status === 201 };
    },
    onSuccess: ({ page }) => invalidatePageContent(qc, page.path),
  });
}
```

(`invalidatePageContent` is already imported at the top of the file; it invalidates `journal.all`, which covers `journal.today` and `journal.recent`.)

- [ ] **Step 4: Run to verify pass**

Run: `bun --cwd ui run test src/api/__tests__/journal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/journal.ts ui/src/api/__tests__/journal.test.tsx
git commit -m "feat(ui): nullable journal-today query and ensure mutation"
```

---

### Task 3: usePageEditor draft mode

**Files:**
- Modify: `ui/src/editor/usePageEditor.ts`
- Test: `ui/src/editor/__tests__/usePageEditor.test.tsx` (append a describe block)

**Interfaces:**
- Consumes: nothing new from other tasks (the `ensure` callback is injected by the caller; tests mock it).
- Produces (Task 4 relies on these exact names):

```ts
export interface EnsuredPage {
  path: string;
  revision: string;
  body: string;
  meta: {
    title?: string | null;
    tags?: string[] | null;
    aliases?: string[] | null;
  };
}

export interface EnsureResult {
  page: EnsuredPage;
  created: boolean;
}

export interface PageEditorOptions {
  /** Create the page on the first save when it does not exist yet. */
  ensure?: () => Promise<EnsureResult>;
}

export function usePageEditor(path: string, options?: PageEditorOptions): PageEditorState;
// PageEditorState gains: isDraft: boolean
```

Task 2's `EnsureJournalResult` structurally satisfies `EnsureResult` (extra `meta.id` etc. are fine).

- [ ] **Step 1: Write the failing tests**

Append to `ui/src/editor/__tests__/usePageEditor.test.tsx`:

```tsx
function notFoundError() {
  return { status: 404, error: "page not found", detail: null, hint: null };
}

function ensuredPage(body = "") {
  return {
    path: "journals/2026-08-06.md",
    revision: "rev-e",
    body,
    meta: { title: "2026-08-06", tags: ["journal"], aliases: [] },
  };
}

async function flushDraftSave() {
  await act(async () => {
    vi.advanceTimersByTime(1500);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("usePageEditor draft mode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    usePageMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: notFoundError(),
      refetch: refetchPageMock,
    });
    useUpdatePageMock.mockImplementation(() => ({
      mutateAsync: mutateAsyncMock,
    }));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("enters draft state on 404 when ensure is provided", () => {
    const ensure = vi.fn();
    const { result } = renderHook(() =>
      usePageEditor("journals/2026-08-06.md", { ensure }),
    );
    expect(result.current.isDraft).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.saveStatus).toBe("saved");
    expect(ensure).not.toHaveBeenCalled();
  });

  it("still surfaces the 404 as an error without ensure", () => {
    const { result } = renderHook(() => usePageEditor("journals/2026-08-06.md"));
    expect(result.current.isDraft).toBe(false);
    expect(result.current.error).not.toBeNull();
  });

  it("ensures before the first update and adopts the template", async () => {
    const ensure = vi
      .fn()
      .mockResolvedValue({ page: ensuredPage(), created: true });
    mutateAsyncMock.mockResolvedValue({ ...makePage("B"), revision: "rev-f" });
    const { result } = renderHook(() =>
      usePageEditor("journals/2026-08-06.md", { ensure }),
    );

    act(() => result.current.onSlateChange(paragraph("B"), astChangeEditor()));
    await flushDraftSave();

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);
    expect(ensure.mock.invocationCallOrder[0]).toBeLessThan(
      mutateAsyncMock.mock.invocationCallOrder[0],
    );
    const request = mutateAsyncMock.mock.calls[0][0];
    expect(request.body.expected_revision).toBe("rev-e");
    expect(request.body.body).toBe("B\n");
    // Untouched template metadata is adopted, not re-sent.
    expect(request.body.title).toBeUndefined();
    expect(result.current.title).toBe("2026-08-06");
    expect(result.current.tags).toEqual(["journal"]);
    expect(result.current.isDraft).toBe(false);
  });

  it("keeps a user-typed title through the first save", async () => {
    const ensure = vi
      .fn()
      .mockResolvedValue({ page: ensuredPage(), created: true });
    mutateAsyncMock.mockResolvedValue({ ...makePage(""), revision: "rev-f" });
    const { result } = renderHook(() =>
      usePageEditor("journals/2026-08-06.md", { ensure }),
    );

    act(() => result.current.setTitle("My day"));
    await flushDraftSave();

    const request = mutateAsyncMock.mock.calls[0][0];
    expect(request.body.title).toBe("My day");
    expect(result.current.title).toBe("My day");
  });

  it("retries ensure on the next save after a failure", async () => {
    const ensure = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ page: ensuredPage(), created: true });
    mutateAsyncMock.mockResolvedValue({ ...makePage("B"), revision: "rev-f" });
    const { result } = renderHook(() =>
      usePageEditor("journals/2026-08-06.md", { ensure }),
    );

    act(() => result.current.onSlateChange(paragraph("B"), astChangeEditor()));
    await flushDraftSave();
    expect(result.current.saveStatus).toBe("error");
    expect(mutateAsyncMock).not.toHaveBeenCalled();
    expect(result.current.isDraft).toBe(true);

    act(() => result.current.onSlateChange(paragraph("Bx"), astChangeEditor()));
    await flushDraftSave();
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);
  });

  it("adopts an existing empty journal without conflict", async () => {
    const ensure = vi
      .fn()
      .mockResolvedValue({ page: ensuredPage(""), created: false });
    mutateAsyncMock.mockResolvedValue({ ...makePage("B"), revision: "rev-f" });
    const { result } = renderHook(() =>
      usePageEditor("journals/2026-08-06.md", { ensure }),
    );

    act(() => result.current.onSlateChange(paragraph("B"), astChangeEditor()));
    await flushDraftSave();

    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);
    expect(result.current.revisionConflict).toBeNull();
  });

  it("raises the conflict flow when the page already has content", async () => {
    const ensure = vi
      .fn()
      .mockResolvedValue({ page: ensuredPage("Someone else\n"), created: false });
    const { result } = renderHook(() =>
      usePageEditor("journals/2026-08-06.md", { ensure }),
    );

    act(() => result.current.onSlateChange(paragraph("B"), astChangeEditor()));
    await flushDraftSave();

    expect(mutateAsyncMock).not.toHaveBeenCalled();
    expect(result.current.saveStatus).toBe("error");
    expect(result.current.revisionConflict).toEqual({
      currentRevision: "rev-e",
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --cwd ui run test src/editor/__tests__/usePageEditor.test.tsx`
Expected: FAIL — the second options argument is not accepted / `isDraft` is undefined; existing tests still PASS.

- [ ] **Step 3: Implement draft mode in `ui/src/editor/usePageEditor.ts`**

Add the exported types (above `PageEditorState`):

```ts
export interface EnsuredPage {
  path: string;
  revision: string;
  body: string;
  meta: {
    title?: string | null;
    tags?: string[] | null;
    aliases?: string[] | null;
  };
}

export interface EnsureResult {
  page: EnsuredPage;
  created: boolean;
}

export interface PageEditorOptions {
  /** Create the page on the first save when it does not exist yet. */
  ensure?: () => Promise<EnsureResult>;
}
```

Add `isDraft: boolean;` to `PageEditorState` (after `error: unknown;`).

Change the signature and add draft detection right after the `usePage` destructure (line ~68):

```ts
export function usePageEditor(
  path: string,
  options?: PageEditorOptions,
): PageEditorState {
  const { data: page, isLoading, error, refetch: refetchPage } = usePage(path);
  const pageNotFound = isApiError(error) && error.status === 404;
  const canDraft = Boolean(options?.ensure);
  const [ensured, setEnsured] = useState(false);
  const isDraft = pageNotFound && canDraft && !ensured && !page;
  // Render-assigned refs so doSave reads current values without new deps
  // (same pattern as doSaveRef below).
  const ensureRef = useRef(options?.ensure);
  ensureRef.current = options?.ensure;
  const isDraftRef = useRef(false);
  isDraftRef.current = isDraft;
```

Reset draft progress when the hook is pointed at a different path (place next to the other effects):

```ts
  // A new path is a new page lifecycle; forget any prior ensure.
  useEffect(() => {
    setEnsured(false);
  }, [path]);
```

In `doSave`, inside the `void (async () => { try {` block, insert the ensure branch immediately before `const response = await updatePageMutateAsync({`:

```ts
        if (isDraftRef.current && ensureRef.current) {
          const result = await ensureRef.current();
          const serverTitle = result.page.meta.title ?? "";
          const serverTags = result.page.meta.tags ?? [];
          const serverAliases = result.page.meta.aliases ?? [];

          if (!result.created && result.page.body.trim() !== "") {
            // The page was created and written elsewhere between load and
            // save. Surface the conflict-reload flow instead of overwriting.
            savingRef.current = false;
            saveRequestedRef.current = false;
            const conflict = { currentRevision: result.page.revision };
            conflictRef.current = conflict;
            setRevisionConflict(conflict);
            setSaveStatus("error");
            setSaveError("page already has content");
            return;
          }

          revisionRef.current = result.page.revision;
          savedRef.current = {
            title: serverTitle,
            tags: serverTags,
            aliases: serverAliases,
            body: result.page.body,
          };
          // Adopt template metadata the user did not touch while drafting;
          // fields they edited diff against the new baseline instead.
          if (titleRef.current === "") {
            titleRef.current = serverTitle;
            setTitleState(serverTitle);
          }
          if (tagsRef.current.length === 0) {
            tagsRef.current = serverTags;
            setTagsState(serverTags);
          }
          if (aliasesRef.current.length === 0) {
            aliasesRef.current = serverAliases;
            setAliasesState(serverAliases);
          }
          isDraftRef.current = false;
          setEnsured(true);
        }
```

Note: the changed-field flags (`bodyChanged`, `titleChanged`, …) are computed before this block against the empty draft baseline — that is intentional. A user who never touched the title yields `titleChanged === false`, so the PUT omits `title` and the server-side template title survives; a user-typed title yields `titleChanged === true` and is sent.

In the returned object, mask the 404 and expose the flag:

```ts
  return {
    isLoading,
    error: pageNotFound && canDraft ? null : error,
    isDraft,
```

(rest of the return unchanged).

- [ ] **Step 4: Run to verify pass**

Run: `bun --cwd ui run test src/editor/__tests__/usePageEditor.test.tsx`
Expected: PASS — all pre-existing tests and the new draft-mode block.

- [ ] **Step 5: Commit**

```bash
git add ui/src/editor/usePageEditor.ts ui/src/editor/__tests__/usePageEditor.test.tsx
git commit -m "feat(editor): draft mode creates the page on first save via ensure callback"
```

---

### Task 4: Diurnal rewiring + Atrium nullability + test rework

**Files:**
- Modify: `ui/src/components/codex/Diurnal.tsx`
- Modify: `ui/src/components/codex/__tests__/EditorConflictWiring.test.tsx`
- Test: `ui/src/components/codex/__tests__/Diurnal.test.tsx` (create)
- (No change to `ui/src/components/codex/Atrium.tsx` — `journalToday?.meta.id` already handles `null`; Task 2's hook test covers the 404 path.)

**Interfaces:**
- Consumes: `useEnsureJournalToday()` from Task 2 (`mutateAsync(): Promise<EnsureJournalResult>`); `usePageEditor(path, { ensure })` and `editor.isDraft` from Task 3.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing Diurnal test**

Create `ui/src/components/codex/__tests__/Diurnal.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { usePageEditorMock, ensureMutateAsyncMock } = vi.hoisted(() => ({
  usePageEditorMock: vi.fn(),
  ensureMutateAsyncMock: vi.fn(),
}));

vi.mock("#/editor/usePageEditor", () => ({
  usePageEditor: usePageEditorMock,
}));
vi.mock("#/editor/SaveIndicator", () => ({
  SaveIndicator: () => null,
}));
vi.mock("#/editor/PageEditorHeader", () => ({
  PageEditorHeader: () => null,
}));
vi.mock("#/editor/SlateEditor", () => ({
  SlateEditor: () => <div data-testid="slate-editor" />,
}));
vi.mock("#/api/index", () => ({
  useBacklinks: () => ({ data: [] }),
}));
vi.mock("#/api/journal", () => ({
  useJournalByDate: () => ({ data: undefined, isLoading: false, error: null }),
  useJournalRecent: () => ({ data: [] }),
  useQuickCapture: () => ({ mutate: vi.fn(), isPending: false }),
  useEnsureJournalToday: () => ({ mutateAsync: ensureMutateAsyncMock }),
}));

import { Diurnal } from "../Diurnal";

function editorState(overrides: Record<string, unknown> = {}) {
  return {
    isLoading: false,
    error: null,
    isDraft: false,
    initialValue: [{ type: "paragraph", children: [{ text: "" }] }],
    editorRevision: 0,
    title: "",
    setTitle: vi.fn(),
    tags: [],
    setTags: vi.fn(),
    aliases: [],
    setAliases: vi.fn(),
    saveStatus: "saved",
    saveError: null,
    revisionConflict: null,
    reloadAfterConflict: vi.fn(),
    onSlateChange: vi.fn(),
    saveNow: vi.fn(),
    createdAt: null,
    updatedAt: null,
    bodyMarkdown: "",
    kind: null,
    inferred: true,
    project: null,
    ...overrides,
  };
}

describe("Diurnal create-on-first-write", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders an editable editor for an unwritten today", () => {
    usePageEditorMock.mockReturnValue(editorState({ isDraft: true }));
    render(<Diurnal />);

    // Bound to today's deterministic path with an ensure callback,
    // without any journal-today fetch.
    const [path, options] = usePageEditorMock.mock.calls[0];
    expect(path).toMatch(/^journals\/\d{4}-\d{2}-\d{2}\.md$/);
    expect(typeof options?.ensure).toBe("function");

    expect(screen.getByTestId("slate-editor")).toBeInTheDocument();
    expect(screen.getByText("unwritten")).toBeInTheDocument();
  });

  it("shows written state once the journal exists", () => {
    usePageEditorMock.mockReturnValue(editorState({ isDraft: false }));
    render(<Diurnal />);
    expect(screen.getByTestId("slate-editor")).toBeInTheDocument();
    expect(screen.getByText("written")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun --cwd ui run test src/components/codex/__tests__/Diurnal.test.tsx`
Expected: FAIL — Diurnal still imports `useJournalToday` (missing from the mock), and no editor renders for an unwritten today.

- [ ] **Step 3: Rewire `ui/src/components/codex/Diurnal.tsx`**

Import changes (lines 3–8): drop `useJournalToday`, add `useEnsureJournalToday` (`useMemo` is already imported from react):

```tsx
import {
  useEnsureJournalToday,
  useJournalByDate,
  useJournalRecent,
  useQuickCapture,
} from "#/api/journal";
```

Replace lines 44–52 (`isToday` through `const editor = usePageEditor(journalPath);`):

```tsx
  const isToday = selectedDate === today;
  const dateQuery = useJournalByDate(isToday ? "" : selectedDate);
  // Today's editor binds to the deterministic journal path before the file
  // exists; the vault's journal layout is fixed server-side in journal_path().
  const journalPath = isToday
    ? `journals/${today}.md`
    : (dateQuery.data?.path ?? "");

  const ensureToday = useEnsureJournalToday();
  const ensureMutateAsync = ensureToday.mutateAsync;
  const editorOptions = useMemo(
    () => (isToday ? { ensure: () => ensureMutateAsync() } : undefined),
    [isToday, ensureMutateAsync],
  );
  const editor = usePageEditor(journalPath, editorOptions);

  const isLoading = isToday ? editor.isLoading : dateQuery.isLoading;
  const fetchError = isToday ? null : dateQuery.error;
```

(`editor` moves above `isLoading` so today's fetching indicator tracks the editor's page load; the old `usePageEditor(journalPath)` call at line 52 is subsumed by this block.)

Update the marginalia "State" row (line ~261–263):

```tsx
            <span className="text-ink-2">
              {(isToday ? !editor.isDraft : Boolean(journalPath))
                ? "written"
                : "unwritten"}
            </span>
```

Everything else is untouched: the editor render gate (`!isLoading && journalPath && !editor.isLoading && !editor.error`) now admits an unwritten today because Task 3 masks the 404 and `journalPath` is always set for today; the "no entry" branch keeps its `!isToday` guard; quick capture is unchanged.

- [ ] **Step 4: Update `EditorConflictWiring.test.tsx` mocks**

Replace the `#/api/journal` mock block (lines 45–54):

```tsx
vi.mock("#/api/journal", () => ({
  useJournalByDate: () => ({ data: undefined, isLoading: false, error: null }),
  useJournalRecent: () => ({ data: [] }),
  useQuickCapture: () => ({ mutate: vi.fn(), isPending: false }),
  useEnsureJournalToday: () => ({ mutateAsync: vi.fn() }),
}));
```

Add `isDraft: false,` to the object returned by `loadedEditor` (after `error: null,` — line ~76).

- [ ] **Step 5: Run to verify pass**

Run: `bun --cwd ui run test src/components/codex/__tests__/Diurnal.test.tsx`
Run: `bun --cwd ui run test src/components/codex/__tests__/EditorConflictWiring.test.tsx`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/codex/Diurnal.tsx ui/src/components/codex/__tests__/Diurnal.test.tsx ui/src/components/codex/__tests__/EditorConflictWiring.test.tsx
git commit -m "feat(ui): Diurnal binds today's editor as a draft; no eager journal creation"
```

---

### Task 5: Verification gates

**Files:** none (verification only).

- [ ] **Step 1: Backend gates**

Run each; all must pass with zero warnings from clippy:

```bash
cargo fmt --check
cargo clippy --all-targets
cargo test
```

- [ ] **Step 2: Frontend gates**

```bash
bun --cwd ui run typecheck
bun --cwd ui run lint
bun --cwd ui run test
```

- [ ] **Step 3: Spec conformance sweep**

Re-read `docs/superpowers/specs/2026-08-06-journal-create-on-first-write-design.md` "Behavior contract" and confirm each bullet maps to a passing test or verified code path. Confirm `rg -n "useJournalToday" ui/src` shows only `ui/src/api/journal.ts` (definition) and `ui/src/components/codex/Atrium.tsx` (consumer).

- [ ] **Step 4: Report**

Report all gate outputs explicitly (per CLAUDE.md verification gates), then hand off to superpowers:finishing-a-development-branch for merge to `develop`.
