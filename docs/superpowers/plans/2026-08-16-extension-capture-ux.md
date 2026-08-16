# Extension Capture UX (TSK-0086 + TSK-0087) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the browser extension a real tag picker with vault-backed and content-derived suggestions (TSK-0086), and honest capture feedback: a progress bar, links to the created note, clickable notifications, and a pre-capture "already captured" indicator (TSK-0087).

**Architecture:** One new read-only server route (`GET /api/vault/archive/lookup`) wraps the existing indexed `find_by_archive_url`. Everything else is extension-side: the worker's `CaptureStatus` gains chunk-progress and outcome fields (persisted/rehydrated as today), and the vanilla-TS popup gains a progress bar, outcome links, an already-captured indicator, and a chip-based tag picker fed by the existing `GET /api/vault/index/tags` endpoint plus a client-side intersection of page signals with vault tags.

**Tech Stack:** Rust (Axum 0.8, utoipa, rusqlite) · extension: vanilla TypeScript, Vite 6 + vite-plugin-web-extension, Vitest (+linkedom), Bun, Biome.

**Spec:** Task pages `tasks/clepsydra/TSK-0086.md` and `tasks/clepsydra/TSK-0087.md` in the vault, plus these locked decisions from the scope interview (2026-08-16):
1. Content-derived suggestions = intersection of the active tab's title/meta signals with **existing vault tags only**, ranked by vault usage. No novel-tag proposals.
2. Already-captured check = **new** `GET /api/vault/archive/lookup?url=…` route (thin wrapper over `find_by_archive_url`), returning status active/rubbish/none + `vault_path`, `page_id`, `captured_at`. Popup checks on open.
3. Progress bar = one bar spanning phases; **determinate across the chunk-assembly span** (chunk `index`/`total`), indeterminate animation for capturing/uploading spans.
4. Success links = popup "View in Clepsydra" anchor **and** clickable system notification, both opening `{server_url}/pages/{vault_path}`. Duplicate/conflict outcomes link to the existing page the same way.

## Global Constraints

- **Never run repo-wide formatters.** develop is not fmt/lint clean (22 Rust files; 175 ui lint errors). No `cargo fmt`, no `biome check --write` at repo scope. Extension-scoped `bun run lint` (`biome check src/`) is allowed only because `extension/src` is verified clean at pre-flight; if a lint run reports pre-existing errors in files you did not touch, stop and report instead of fixing them.
- **Extension commands run from `extension/`**: `cd extension && bun run test` / `bun run typecheck` / `bun run lint`. Never `bun --cwd` (broken). Single test file: `cd extension && bun run test src/lib/__tests__/<file>.test.ts`.
- **Backend gates:** `cargo test --test archive_test`, `cargo test --test openapi_contract`, `cargo test --test docs_api_coverage_test`, `cargo clippy --all-targets -- -D warnings` (clippy must not add new warnings in touched files; pre-existing warnings elsewhere are not yours to fix).
- **After the backend route lands (Task 1):** regenerate `ui/src/api/schema.d.ts` — start `cargo run -- serve` in the background, run `cd ui && bun run openapi`, stop the server, commit the regenerated file. Do not hand-edit `schema.d.ts`.
- **Docs coverage is enforced by a test:** every OpenAPI operation must have a `### \`VERB /api/vault/...\`` heading under its tag section in `ui/src/docs/content/api-reference.mdx` (see `tests/docs_api_coverage_test.rs`). Task 1 adds the heading for the new route.
- The extension has **no framework**: popup code is vanilla DOM in `popup.ts` + inline CSS in `popup.html`. Match that style; do not introduce dependencies.
- All user-facing popup copy is sentence-style with a trailing period, matching existing strings ("Applies only to this capture.").
- Commit per task with conventional messages (`feat(extension): …`, `feat(api): …`, `test: …`).
- Branch: `feature/tsk-0086-0087-extension-capture` off `develop`.

## File Structure

| File | Task | Change |
| --- | --- | --- |
| `src/vault/index.rs` | 1 | Add `archive_captured_at(page_id)` next to `find_by_archive_url` |
| `src/api/archive.rs` | 1 | `ArchiveLookupQuery/Response/Status` DTOs, `lookup_archive` handler, route |
| `src/api/openapi.rs` | 1 | Register path + schemas |
| `tests/archive_test.rs` | 1 | Four lookup tests |
| `ui/src/docs/content/api-reference.mdx` | 1 | Heading for the new operation |
| `ui/src/api/schema.d.ts` | 1 | Regenerated |
| `extension/src/lib/badge.ts` | 2 | `CaptureStatus` optional progress/outcome fields |
| `extension/src/lib/types.ts` | 2, 4 | `ArchiveResponse.rubbish_item_id` drift fix; `ArchiveLookupResponse` |
| `extension/src/background/service-worker.ts` | 2, 3 | `reportPhase` extras, chunk progress, outcome fields, notification click-through |
| `extension/src/lib/page-url.ts` | 3 | New: shared `pageUrl(serverUrl, vaultPath)` |
| `extension/src/popup/popup.html` | 3, 4, 5, 6 | Progress bar, outcome link, indicator, tag-picker markup + CSS |
| `extension/src/popup/popup.ts` | 3, 4, 5, 6 | Bar rendering, link, lookup call, picker wiring, suggested chips |
| `extension/src/lib/api-client.ts` | 4, 5, 6 | `lookupArchive`, `suggestTags`, `listTags` |
| `extension/src/popup/tag-picker.ts` | 5 | New: vanilla combobox/chips component |
| `extension/src/popup/content-suggestions.ts` | 6 | New: tokenize + intersect pure functions |
| `extension/src/lib/capture-tags.ts` | 6 | Export `currentMonthTag` (moved from service-worker) |
| `extension/README.md` | 4 | Document the two additional GET endpoints the extension calls |
| Tests: `extension/src/background/service-worker.test.ts`, `extension/src/popup/popup.test.ts`, new `extension/src/popup/tag-picker.test.ts`, new `extension/src/popup/content-suggestions.test.ts` | 2–6 | Per task |

Task order is 1 → 2 → 3 → 4 → 5 → 6. Tasks 2→3 share `CaptureStatus`; 1→4 share the lookup contract; 5→6 share the picker API. Tasks 3–6 all touch `popup.html`/`popup.ts`, so they must run sequentially.

---

### Task 1: Archive URL lookup endpoint (backend)

**Files:**
- Modify: `src/vault/index.rs` (next to `find_by_archive_url`, which ends near line 1717)
- Modify: `src/api/archive.rs` (DTOs near line 84, router at line 313, handlers near line 1100)
- Modify: `src/api/openapi.rs` (paths list near line 158, schemas near line 372)
- Modify: `ui/src/docs/content/api-reference.mdx` (Archive section, after the `GET /api/vault/archive/status` entry at line 105)
- Test: `tests/archive_test.rs`
- Regenerate: `ui/src/api/schema.d.ts`

**Interfaces:**
- Consumes: `VaultIndex::find_by_archive_url` / `ArchiveUrlOwner` (`src/vault/index.rs:126-139, 1676`), `validate_http_url` (already used by `ingest_archive` at `src/api/archive.rs:1153`), `state.index.with_index` (pattern at `archive.rs:1181-1186`), test helpers `setup_server`, `archive_url_payload`, `publish_rubbish_archive`, `ApiFixture::builder().pre_index_seed` (`tests/archive_test.rs:26, 354, 369, 705`).
- Produces (Task 4 depends on this exact contract): `GET /api/vault/archive/lookup?url=<http(s) URL>` → `200 {"status": "active"|"rubbish"|"none", "page_id"?, "vault_path"?, "captured_at"?}` (absent fields omitted), `400` on non-http(s) `url`.

- [ ] **Step 1: Write the failing tests** — append to `tests/archive_test.rs` (they use only existing helpers):

```rust
// ---------------------------------------------------------------------------
// Archive lookup tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn archive_lookup_reports_absent_url() {
    let (server, _tmp, _state) = setup_server();
    let response = server
        .get("/api/vault/archive/lookup")
        .add_query_param("url", "https://example.com/never-captured")
        .await;
    response.assert_status(StatusCode::OK);
    let body: serde_json::Value = response.json();
    assert_eq!(body["status"], "none");
    assert!(body.get("page_id").is_none());
    assert!(body.get("vault_path").is_none());
    assert!(body.get("captured_at").is_none());
}

#[tokio::test]
async fn archive_lookup_reports_active_capture_with_captured_at() {
    let (server, _tmp, _state) = setup_server();
    let url = "https://example.com/lookup-active";
    server
        .post("/api/vault/archive")
        .json(&archive_url_payload(url, None))
        .await
        .assert_status(StatusCode::CREATED);

    let response = server
        .get("/api/vault/archive/lookup")
        .add_query_param("url", url)
        .await;
    response.assert_status(StatusCode::OK);
    let body: serde_json::Value = response.json();
    assert_eq!(body["status"], "active");
    assert!(body["page_id"].as_str().is_some());
    assert!(
        body["vault_path"]
            .as_str()
            .unwrap()
            .starts_with("archive/example.com/")
    );
    // archive_url_payload declares this capture timestamp verbatim.
    assert_eq!(body["captured_at"], "2026-08-13T12:00:00Z");
}

#[tokio::test]
async fn archive_lookup_reports_rubbish_capture() {
    const ITEM_ID: &str = "00000000-0000-4000-8000-000000000051";
    const PAGE_ID: &str = "10000000-0000-4000-8000-000000000051";
    const ORIGINAL_PATH: &str = "archive/example.com/binned-lookup.md";
    const URL: &str = "https://example.com/binned-lookup";

    let (server, _tmp, _state) = ApiFixture::builder()
        .pre_index_seed(|root| {
            publish_rubbish_archive(root, ITEM_ID, PAGE_ID, ORIGINAL_PATH, URL);
        })
        .build()
        .into_parts();

    let response = server
        .get("/api/vault/archive/lookup")
        .add_query_param("url", URL)
        .await;
    response.assert_status(StatusCode::OK);
    let body: serde_json::Value = response.json();
    assert_eq!(body["status"], "rubbish");
    assert_eq!(body["page_id"], PAGE_ID);
    assert_eq!(body["vault_path"], ORIGINAL_PATH);
    assert!(body.get("captured_at").is_none());
}

#[tokio::test]
async fn archive_lookup_rejects_non_http_url() {
    let (server, _tmp, _state) = setup_server();
    let response = server
        .get("/api/vault/archive/lookup")
        .add_query_param("url", "clepsydra://pages/notes/x.md")
        .await;
    response.assert_status(StatusCode::BAD_REQUEST);
}
```

- [ ] **Step 2: Run them to verify they fail** — `cargo test --test archive_test archive_lookup` — expected: 404-shaped failures (route absent), all four FAIL.

- [ ] **Step 3: Add the index accessor** — in `src/vault/index.rs`, directly after `find_by_archive_url` (inside the same `impl` block):

```rust
    /// `archive.captured_at` for an indexed page, if the page exists and
    /// carries archive frontmatter.
    pub fn archive_captured_at(&self, page_id: &str) -> Result<Option<String>, IndexError> {
        Ok(self
            .conn
            .query_row(
                "SELECT json_extract(meta_json, '$.archive.captured_at')
                 FROM pages WHERE id = ?1",
                params![page_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }
```

- [ ] **Step 4: Add DTOs, handler, and route** — in `src/api/archive.rs`. Add `Query` to the `axum::extract` import at line 10 and `IntoParams` to the utoipa import at line 18. After `ArchiveStatsResponse` (line 90):

```rust
#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ArchiveLookupQuery {
    /// http(s) source URL to look up.
    pub url: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ArchiveLookupResponse {
    pub status: ArchiveLookupStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captured_at: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveLookupStatus {
    Active,
    Rubbish,
    None,
}
```

Handler, next to `archive_status` (after line 1124). The doc comment's first line becomes the OpenAPI summary the docs test matches:

```rust
/// Capture ownership for a source URL.
///
/// Read-only companion to `POST /archive`: the extension calls it before a
/// capture to say whether this URL already lives in the vault (or its
/// Rubbish Bin) without sending a snapshot.
#[utoipa::path(
    get,
    path = "/archive/lookup",
    context_path = "/api/vault",
    tag = "Archive",
    params(ArchiveLookupQuery),
    responses(
        (status = 200, description = "Capture ownership for the URL", body = ArchiveLookupResponse),
        (status = 400, description = "Invalid url parameter", body = ApiError),
        (status = 500, description = "Internal server error", body = ApiError)
    )
)]
pub async fn lookup_archive(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ArchiveLookupQuery>,
) -> Result<Json<ArchiveLookupResponse>, ApiError> {
    validate_http_url("url", &query.url)?;

    let url = query.url.clone();
    let owner = state
        .index
        .with_index(move |index, _vault| index.find_by_archive_url(&url))
        .await
        .map_err(|e| ApiError::internal(format!("index lookup: {e}")))?
        .map_err(|e| ApiError::internal(format!("index lookup: {e}")))?;

    let response = match owner {
        None => ArchiveLookupResponse {
            status: ArchiveLookupStatus::None,
            page_id: None,
            vault_path: None,
            captured_at: None,
        },
        Some(ArchiveUrlOwner::Active { page_id, path, .. }) => {
            let id = page_id.clone();
            let captured_at = state
                .index
                .with_index(move |index, _vault| index.archive_captured_at(&id))
                .await
                .map_err(|e| ApiError::internal(format!("index lookup: {e}")))?
                .map_err(|e| ApiError::internal(format!("index lookup: {e}")))?;
            ArchiveLookupResponse {
                status: ArchiveLookupStatus::Active,
                page_id: Some(page_id),
                vault_path: Some(path),
                captured_at,
            }
        }
        Some(ArchiveUrlOwner::Rubbish {
            page_id,
            original_path,
            ..
        }) => ArchiveLookupResponse {
            status: ArchiveLookupStatus::Rubbish,
            page_id: Some(page_id),
            vault_path: Some(original_path),
            captured_at: None,
        },
    };
    Ok(Json(response))
}
```

Route, in `router_with_body_limit` (line 317-328), after the `/status` line:

```rust
        .route("/lookup", get(lookup_archive))
```

- [ ] **Step 5: Register in OpenAPI** — `src/api/openapi.rs`: add `crate::api::archive::lookup_archive,` beside the other archive paths (line 156-160) and `crate::api::archive::ArchiveLookupResponse,` + `crate::api::archive::ArchiveLookupStatus,` beside the other archive schemas (line 369-372). (`ArchiveLookupQuery` is `IntoParams`, not a schema — do not list it.)

- [ ] **Step 6: Document the operation** — `ui/src/docs/content/api-reference.mdx`, after the `GET /api/vault/archive/status` entry (line 105-106), matching the file's exact format:

```markdown
### `GET /api/vault/archive/lookup`
Capture ownership for a source URL. Responses: `200` Capture ownership for the URL; `400` Invalid url parameter; `500` Internal server error.
```

- [ ] **Step 7: Run the gates** — `cargo test --test archive_test archive_lookup` (4 PASS), then `cargo test --test archive_test` (full file), `cargo test --test openapi_contract`, `cargo test --test docs_api_coverage_test`, `cargo clippy --all-targets` (no new warnings in touched files).

- [ ] **Step 8: Regenerate the UI schema** — `cargo build`, start `cargo run -- serve` in the background, `cd ui && bun run openapi`, stop the server. Confirm `ui/src/api/schema.d.ts` gained the lookup operation.

- [ ] **Step 9: Commit**

```bash
git add src/vault/index.rs src/api/archive.rs src/api/openapi.rs tests/archive_test.rs ui/src/docs/content/api-reference.mdx ui/src/api/schema.d.ts
git commit -m "feat(api): archive URL lookup endpoint for pre-capture checks"
```

---

### Task 2: Capture status carries chunk progress and outcome (worker)

**Files:**
- Modify: `extension/src/lib/badge.ts` (interface at lines 17-27)
- Modify: `extension/src/lib/types.ts` (`ArchiveResponse` at lines 22-28)
- Modify: `extension/src/background/service-worker.ts` (`reportPhase` at 464, `CAPTURE_CHUNK` branch at 691, `processCapture` outcomes at 122-165, `isCaptureStatus`/`rehydrateStatuses` at 280-338)
- Test: `extension/src/background/service-worker.test.ts`

**Interfaces:**
- Consumes: `CaptureChunk.index`/`.total` (`extension/src/lib/chunked-transfer.ts:20-26`), `ArchiveConflictDetail` (`lib/types.ts:37-42`).
- Produces (Task 3 renders these): `CaptureStatus` gains four optional fields — `chunksReceived?: number; chunksTotal?: number; vaultPath?: string; pageId?: string`. `reportPhase` gains a fifth parameter `extra: CaptureStatusExtra = {}` merged into the status. Terminal statuses `done`/`duplicate` carry `vaultPath`+`pageId` from `ArchiveResponse`; `conflict` carries them from the 409 detail when present. Progress fields are only ever set during `processing`.

- [ ] **Step 1: Write the failing tests** — add to `service-worker.test.ts`, reusing the suite's existing message-dispatch and fetch-mock helpers (read the top of the file first; drive the worker through its `runtime.onMessage` listener exactly as neighbouring tests do):
  - `chunk progress is reported while a transfer assembles`: start a capture, send `capture_meta`, then chunk 0 of total 2 → `capture_status` response has `phase: "processing"`, `chunksReceived: 1`, `chunksTotal: 2`.
  - `done status carries the created page location`: complete a capture with the fetch mock returning 201 `{page_id: "pid-1", vault_path: "archive/example.com/x.md", blobs_stored: 1, blobs_deduped: 0, status: "created"}` → terminal status has `vaultPath: "archive/example.com/x.md"`, `pageId: "pid-1"`.
  - `duplicate status carries the existing page location`: fetch mock 200 `{status: "already_exists", page_id: "pid-2", vault_path: "archive/example.com/y.md", …}` → `phase: "duplicate"` with both fields.
  - `conflict status carries the existing page location`: fetch mock 409 whose `detail` includes `page_id`/`vault_path` → `phase: "conflict"` with both fields.
  - `rehydration keeps outcome fields and drops malformed ones`: seed session storage with a terminal `done` status including `vaultPath`/`pageId` (kept verbatim) and another entry whose `chunksTotal` is a string (field dropped, rest kept).
- [ ] **Step 2: Run to verify failures** — `cd extension && bun run test src/background/service-worker.test.ts` — new tests FAIL (fields undefined).
- [ ] **Step 3: Implement.**

`badge.ts`, extend the interface (after `additionalTags`):

```ts
	/** Chunk-assembly progress; present only while phase is "processing". */
	chunksReceived?: number;
	chunksTotal?: number;
	/** Where the capture landed; present on done/duplicate/conflict. */
	vaultPath?: string;
	pageId?: string;
```

`types.ts`, fix the response drift (matches `src/api/archive.rs:65-74`):

```ts
export interface ArchiveResponse {
	page_id: string;
	vault_path: string;
	rubbish_item_id?: string;
	blobs_stored: number;
	blobs_deduped: number;
	status: "created" | "already_exists" | "content_changed";
}
```

`service-worker.ts` — `reportPhase` merges extras (fields persist unless overwritten; when the phase leaves `processing`, explicitly drop the chunk fields):

```ts
type CaptureStatusExtra = Partial<
	Pick<CaptureStatus, "chunksReceived" | "chunksTotal" | "vaultPath" | "pageId">
>;

async function reportPhase(
	tabId: number | undefined,
	attemptId: string,
	phase: CapturePhase,
	detail: string = describePhase(phase),
	extra: CaptureStatusExtra = {},
): Promise<boolean> {
	if (tabId === undefined) return false;
	const current = statuses.get(tabId);
	if (!current || current.attemptId !== attemptId) return false;

	const status: CaptureStatus = {
		...current,
		...extra,
		phase,
		detail,
		updatedAt: nextStatusTimestamp(current),
	};
	if (phase !== "processing") {
		delete status.chunksReceived;
		delete status.chunksTotal;
	}
	statuses.set(tabId, status);
	// … unchanged remainder
```

`CAPTURE_CHUNK` branch — report progress on each accepted-but-incomplete chunk. Replace the current early return:

```ts
		if (completed === null) {
			if (statuses.get(tabId ?? -1)?.attemptId === attemptId) {
				void reportPhase(tabId, attemptId, "processing", undefined, {
					chunksReceived: workerMessage.index + 1,
					chunksTotal: workerMessage.total,
				});
			}
			return undefined;
		}
		if (statuses.get(tabId ?? -1)?.attemptId !== attemptId) {
			return undefined;
		}
```

`processCapture` outcomes — pass extras (conflict via a `detail` cast to `ArchiveConflictDetail`):
- duplicate: `reportPhase(tabId, attemptId, "duplicate", \`${metadata.title} was already archived.\`, { vaultPath: response.vault_path, pageId: response.page_id })`
- done: same shape with the done detail string.
- conflict: extract `const conflictDetail = err.detail as ArchiveConflictDetail | undefined;` and pass `{ vaultPath: conflictDetail?.vault_path, pageId: conflictDetail?.page_id }`.

`isCaptureStatus` — after the existing required-field checks, add optional-field validation:

```ts
	const optionalString = (v: unknown) => v === undefined || typeof v === "string";
	const optionalCount = (v: unknown) =>
		v === undefined ||
		(typeof v === "number" && Number.isFinite(v) && v >= 0);
```

Rather than rejecting the whole status on a malformed optional, `rehydrateStatuses` copies each optional field only when it validates, and sets `repaired = true` when one is dropped. Extend `StoredCaptureStatus` so the optionals come through as `unknown`.

- [ ] **Step 4: Run the gates** — `cd extension && bun run test && bun run typecheck && bun run lint`.
- [ ] **Step 5: Commit**

```bash
git add extension/src/lib/badge.ts extension/src/lib/types.ts extension/src/background/service-worker.ts extension/src/background/service-worker.test.ts
git commit -m "feat(extension): capture status carries chunk progress and outcome location"
```

---

### Task 3: Progress bar, outcome links, clickable notifications (popup + worker)

**Files:**
- Create: `extension/src/lib/page-url.ts`
- Modify: `extension/src/popup/popup.html` (markup after the capture button, CSS in the inline style block)
- Modify: `extension/src/popup/popup.ts`
- Modify: `extension/src/background/service-worker.ts` (`showNotification` at 180, listener registrations near the file end)
- Check/modify: `extension/scripts/verify-bundle.mjs` (if it asserts an exact listener set, add the new notifications listener)
- Test: `extension/src/popup/popup.test.ts`, `extension/src/background/service-worker.test.ts`, new `extension/src/lib/__tests__/page-url.test.ts`

**Interfaces:**
- Consumes: `CaptureStatus.chunksReceived/chunksTotal/vaultPath/pageId` from Task 2.
- Produces: `pageUrl(serverUrl: string, vaultPath: string): string` in `lib/page-url.ts`, used by popup (Tasks 3, 4) and worker.

- [ ] **Step 1: Write the failing tests.**
  - `page-url.test.ts`: `pageUrl("http://localhost:3000", "archive/example.com/a b.md")` → `"http://localhost:3000/pages/archive/example.com/a%20b.md"`; trailing-slash server URL collapses (`"http://x/"` → no double slash); each segment is percent-encoded but `/` separators survive.
  - `popup.test.ts`: (a) an in-progress `processing` status with `chunksReceived: 3, chunksTotal: 4` renders the progress bar visible, determinate, `aria-valuenow` = computed percent; (b) a `capturing` status renders the bar with the `indeterminate` class and no `aria-valuenow`; (c) a terminal `done` status with `vaultPath` hides the bar and shows the `#capture-link` anchor with the encoded href and `target="_blank"`; (d) terminal `error` (no `vaultPath`) leaves the link hidden.
  - `service-worker.test.ts`: (a) after a successful capture, the created notification's id maps to the page URL and a synthetic `notifications.onClicked` with that id calls `tabs.create({url})` once; (b) an unknown notification id does not call `tabs.create`; (c) a platform without `notifications` (Safari) registers nothing and does not throw.
- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement.**

`lib/page-url.ts`:

```ts
/** App URL for a vault page: segments are encoded, separators survive. */
export function pageUrl(serverUrl: string, vaultPath: string): string {
	const base = serverUrl.replace(/\/+$/, "");
	const path = vaultPath.split("/").map(encodeURIComponent).join("/");
	return `${base}/pages/${path}`;
}
```

`popup.html` — after the capture button (line 169):

```html
  <div class="capture-progress" id="capture-progress" hidden
       role="progressbar" aria-label="Capture progress"
       aria-valuemin="0" aria-valuemax="100">
    <div class="capture-progress-fill" id="capture-progress-fill"></div>
  </div>
```

and inside the capture-status area, after `#capture-status` (line 170):

```html
  <a class="capture-link" id="capture-link" hidden target="_blank" rel="noopener">View in Clepsydra</a>
```

CSS (in the inline style block, near `.capture-status`):

```css
    .capture-progress {
      height: 4px;
      margin-top: var(--space-2);
      border: var(--border-width) solid var(--color-subtle);
      background: var(--color-canvas);
    }
    .capture-progress-fill {
      height: 100%;
      width: 0%;
      background: var(--color-processing);
      transition: width 150ms ease-out;
    }
    .capture-progress-fill.indeterminate {
      width: 30%;
      animation: capture-progress-slide 1.2s ease-in-out infinite alternate;
    }
    @keyframes capture-progress-slide {
      from { margin-left: 0; }
      to { margin-left: 70%; }
    }
    .capture-link {
      display: inline-block;
      margin-top: var(--space-1);
      font-size: var(--font-size-meta);
      color: var(--color-ink);
    }
```

`popup.ts` — pure percent function + rendering:

```ts
/** Percent for the determinate span; null renders the indeterminate slide. */
function progressPercent(status: CaptureStatus): number | null {
	if (status.phase === "processing") {
		const { chunksReceived, chunksTotal } = status;
		if (
			chunksReceived === undefined ||
			chunksTotal === undefined ||
			chunksTotal <= 0
		) {
			return null;
		}
		return 15 + Math.round(65 * Math.min(1, chunksReceived / chunksTotal));
	}
	if (status.phase === "uploading") return 85;
	return null;
}
```

Wire into rendering: hoist the `settings` variable from the async IIFE to `init` scope (`let settings: ExtensionSettings = DEFAULT_SETTINGS;`) so render helpers can build links. Add a `renderProgress(active: boolean, percent: number | null)` helper that shows/hides `#capture-progress`, toggles the `indeterminate` class, sets the fill width and `aria-valuenow` (removed when indeterminate). `renderPhase` calls `renderProgress(isInProgress(phase), null)`; `renderStatus` calls `renderProgress(isInProgress(status.phase), progressPercent(status))` and then renders the link:

```ts
		const link = document.getElementById("capture-link") as HTMLAnchorElement;
		if (!isInProgress(status.phase) && status.vaultPath) {
			link.href = pageUrl(settings.server_url, status.vaultPath);
			link.hidden = false;
		} else {
			link.hidden = true;
		}
```

`service-worker.ts` — notification click-through:

```ts
const notificationUrls = new Map<string, string>();
let notificationSequence = 0;

function showNotification(
	title: string,
	message: string,
	targetUrl?: string,
): void {
	const notifications = webext.notifications;
	if (!notifications?.create) return;
	notificationSequence += 1;
	const notificationId = `clepsydra-${notificationSequence.toString(36)}`;
	if (targetUrl) notificationUrls.set(notificationId, targetUrl);
	try {
		void Promise.resolve(
			notifications.create(notificationId, {
				type: "basic",
				iconUrl: webext.runtime.getURL("icons/icon-128.png"),
				title,
				message,
			}),
		).catch(() => {
			notificationUrls.delete(notificationId);
		});
	} catch {
		notificationUrls.delete(notificationId);
	}
}

webext.notifications?.onClicked?.addListener((notificationId: string) => {
	const url = notificationUrls.get(notificationId);
	if (!url) return;
	notificationUrls.delete(notificationId);
	void webext.tabs.create({ url });
});
```

Success/duplicate/conflict call sites pass `pageUrl(settings.server_url, response.vault_path)` (or the conflict detail's path) as `targetUrl`. Keep the existing icon-URL comment. Check `scripts/verify-bundle.mjs`: if it enumerates registered listeners, add the notifications listener to the expected set (guarded — it only registers when the API exists, so assert accordingly or leave it out of the mandatory set).

- [ ] **Step 4: Run the gates** — `cd extension && bun run test && bun run typecheck && bun run lint && bun run build` (build exercises verify-bundle).
- [ ] **Step 5: Commit**

```bash
git add extension/src/lib/page-url.ts extension/src/lib/__tests__/page-url.test.ts extension/src/popup/popup.html extension/src/popup/popup.ts extension/src/background/service-worker.ts extension/src/background/service-worker.test.ts extension/src/popup/popup.test.ts extension/scripts/verify-bundle.mjs
git commit -m "feat(extension): capture progress bar, outcome links, clickable notifications"
```

---

### Task 4: Already-captured indicator (popup)

**Files:**
- Modify: `extension/src/lib/types.ts`, `extension/src/lib/api-client.ts`
- Modify: `extension/src/popup/popup.html`, `extension/src/popup/popup.ts`
- Modify: `extension/README.md`
- Test: `extension/src/popup/popup.test.ts`, `extension/src/lib/__tests__/api-client.test.ts` (extend the existing client suite)

**Interfaces:**
- Consumes: Task 1's response contract; `pageUrl` from Task 3; `isRestrictedUrl` (`lib/injection.ts`).
- Produces: `ClepsydraClient.lookupArchive(url: string): Promise<ArchiveLookupResponse>`.

- [ ] **Step 1: Write the failing tests.**
  - client: `lookupArchive` hits `GET {base}/api/vault/archive/lookup?url=<encoded>` and returns the parsed body; non-OK → throws `ArchiveError`.
  - popup: (a) active lookup `{status:"active", vault_path:"archive/example.com/x.md", captured_at:"2026-08-13T12:00:00Z"}` renders `#captured-indicator` visible containing a formatted date and a View link with the encoded page href; (b) `{status:"rubbish", …}` renders "A previous capture of this page is in the Rubbish Bin."; (c) `{status:"none"}` leaves the indicator hidden; (d) a rejected lookup leaves the indicator hidden and the capture button enabled; (e) a non-http tab URL performs no lookup fetch.
- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement.**

`types.ts`:

```ts
export type ArchiveLookupStatus = "active" | "rubbish" | "none";

export interface ArchiveLookupResponse {
	status: ArchiveLookupStatus;
	page_id?: string;
	vault_path?: string;
	captured_at?: string;
}
```

`api-client.ts`:

```ts
	async lookupArchive(url: string): Promise<ArchiveLookupResponse> {
		const res = await fetch(
			`${this.baseUrl}/api/vault/archive/lookup?url=${encodeURIComponent(url)}`,
		);
		if (!res.ok) {
			throw new ArchiveError(`Lookup failed: ${res.status}`);
		}
		return res.json();
	}
```

`popup.html` — after the status row (line 160):

```html
  <div class="captured-indicator" id="captured-indicator" hidden></div>
```

```css
    .captured-indicator {
      margin-bottom: var(--space-2);
      color: var(--color-muted);
      font-size: var(--font-size-caption);
      line-height: var(--line-height-copy);
    }
    .captured-indicator a { color: var(--color-ink); }
```

`popup.ts` — helpers + a best-effort lookup inside the init IIFE, after the tab is known and not restricted:

```ts
function formatCapturedDate(iso: string): string {
	const parsed = new Date(iso);
	return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleDateString();
}
```

```ts
			if (tab.url && /^https?:/i.test(tab.url)) {
				void client
					.lookupArchive(tab.url)
					.then((lookup) => {
						if (stopped || captureUiGeneration !== openingGeneration) return;
						renderCapturedIndicator(lookup);
					})
					.catch(() => {
						// The indicator is best-effort; capture stays available.
					});
			}
```

`renderCapturedIndicator(lookup)` (closure over the indicator element and `settings`): `active` with `vault_path` → text "Captured <date> — " plus an anchor "View" (`pageUrl(...)`, `target="_blank"`, `rel="noopener"`), preferring `formatCapturedDate(lookup.captured_at)` and the text "Captured previously — " when `captured_at` is absent; `rubbish` → textContent "A previous capture of this page is in the Rubbish Bin."; `none` → keep hidden.

`README.md` — in the endpoints paragraph, extend the list of endpoints the extension calls with `GET /api/vault/archive/lookup` (pre-capture check). (Task 5 adds the tags endpoint to the same sentence.)

- [ ] **Step 4: Run the gates** — `cd extension && bun run test && bun run typecheck && bun run lint`.
- [ ] **Step 5: Commit**

```bash
git add extension/src/lib/types.ts extension/src/lib/api-client.ts extension/src/popup/popup.html extension/src/popup/popup.ts extension/src/popup/popup.test.ts extension/src/lib/__tests__ extension/README.md
git commit -m "feat(extension): already-captured indicator in the popup"
```

---

### Task 5: Tag picker with vault suggestions (popup)

**Files:**
- Create: `extension/src/popup/tag-picker.ts`
- Create: `extension/src/popup/tag-picker.test.ts`
- Modify: `extension/src/lib/api-client.ts` (`suggestTags`)
- Modify: `extension/src/popup/popup.html`, `extension/src/popup/popup.ts`
- Modify: `extension/README.md` (add `GET /api/vault/index/tags` to the endpoints sentence)
- Test: also update `extension/src/popup/popup.test.ts`, `extension/src/lib/__tests__/api-client.test.ts`

**Interfaces:**
- Consumes: server `GET /api/vault/index/tags?q=&limit=` → `[{tag, count, computed_count}]` (`src/api/index_routes.rs:103-119`; limit clamped 1..50); `normalizeCaptureTags` (`lib/capture-tags.ts`).
- Produces (Task 6 depends on this API):

```ts
export interface TagPickerOptions {
	input: HTMLInputElement;
	chipList: HTMLElement;
	suggestionList: HTMLElement; // <ul role="listbox">
	fetchSuggestions: (query: string) => Promise<string[]>;
	onTagsChanged?: (tags: readonly string[]) => void;
	debounceMs?: number; // default 200
}
export interface TagPicker {
	getTags(): string[];
	setTags(tags: readonly string[]): void;
	addTag(tag: string): void;
	commitInput(): void;
	setDisabled(disabled: boolean): void;
	destroy(): void;
}
export function createTagPicker(options: TagPickerOptions): TagPicker;
```

- [ ] **Step 1: Write the failing tests** (`tag-picker.test.ts`, linkedom + fake timers, fake `fetchSuggestions`):
  - Enter on free text commits a normalized tag chip (`" Research "` → `research`) and clears the input; comma commits likewise.
  - Duplicate commits are ignored (one chip).
  - Typing debounces 200 ms then calls `fetchSuggestions` once with the query; the listbox renders the returned options; ArrowDown + Enter selects the active option into a chip and closes the list.
  - Escape closes the list without committing; Backspace in an empty input removes the last chip.
  - A chip's remove button (aria-label `Remove tag <name>`) removes it; `onTagsChanged` fires on every add/remove.
  - `fetchSuggestions` rejection closes/keeps-hidden the list and typing/committing still works.
  - `setDisabled(true)` disables the input and remove buttons; `setTags` replaces chips wholesale.
  - popup.test.ts: capture start sends `additionalTags` = chips plus any uncommitted input text (via `commitInput()`); an in-progress status round-trips into chips (`setTags(status.additionalTags)`).
  - api-client suite: `suggestTags("Res")` hits `/api/vault/index/tags?q=res&limit=8` and maps to `["research", …]`; empty/whitespace query resolves `[]` without fetching.
- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement.**

`api-client.ts`:

```ts
	async suggestTags(query: string, limit = 8): Promise<string[]> {
		const q = query.trim().toLowerCase();
		if (q === "") return [];
		const res = await fetch(
			`${this.baseUrl}/api/vault/index/tags?q=${encodeURIComponent(q)}&limit=${limit}`,
		);
		if (!res.ok) {
			throw new ArchiveError(`Tag suggestions failed: ${res.status}`);
		}
		const tags: { tag: string }[] = await res.json();
		return tags.map((entry) => entry.tag);
	}
```

`popup.html` — replace the additional-tags block (lines 164-167) with:

```html
    <label class="field-label" for="additional-tags">Additional tags</label>
    <div id="selected-tags" class="tag-list" aria-live="polite"></div>
    <input id="additional-tags" type="text" autocomplete="off" role="combobox"
           aria-expanded="false" aria-controls="tag-suggestions" aria-autocomplete="list"
           placeholder="research, reading" aria-describedby="additional-tags-help">
    <ul id="tag-suggestions" class="tag-suggestions" role="listbox" hidden></ul>
    <p id="additional-tags-help" class="field-help">Applies only to this capture. Type to search vault tags.</p>
```

CSS additions:

```css
    .tag-suggestions {
      margin: 0;
      padding: 0;
      border: var(--border-width) solid var(--color-muted);
      border-top: none;
      background: var(--color-canvas);
      list-style: none;
      max-height: 132px;
      overflow-y: auto;
    }
    .tag-suggestions [role="option"] {
      padding: var(--space-1) var(--space-2);
      cursor: pointer;
    }
    .tag-suggestions [role="option"][aria-selected="true"],
    .tag-suggestions [role="option"]:hover {
      background: var(--color-hover);
    }
    .tag-remove {
      width: auto;
      min-height: 0;
      margin-left: var(--space-1);
      padding: 0;
      border: none;
      background: none;
      color: var(--color-muted);
      font: inherit;
      cursor: pointer;
    }
```

`tag-picker.ts` — vanilla implementation of the interface above. Requirements the tests pin down:
- Internal `tags: string[]`; every mutation re-renders chips (span.tag + button.tag-remove with `aria-label`), calls `onTagsChanged`.
- Commit path: `normalizeCaptureTags([text])`, skip empties/duplicates.
- Keys on the input: `Enter` (active option ?? free text; `preventDefault`), `,` (free text; `preventDefault`), `ArrowDown`/`ArrowUp` (move `aria-activedescendant` over `tag-suggestion-<i>` ids; `aria-selected` mirrors), `Escape` (close list), `Backspace` with empty value (remove last chip).
- Debounced fetch: `debounceMs` default 200; ignore out-of-order resolutions (generation counter); empty query closes the list; rejection closes the list silently.
- `aria-expanded` reflects list visibility; list options get `role="option"`; pointer `mousedown` on an option commits it (mousedown, so the input keeps focus).
- `destroy()` removes listeners and pending timers.

`popup.ts` — instantiate after settings load: `const picker = createTagPicker({ input: additionalInput, chipList: selectedTags, suggestionList: suggestionEl, fetchSuggestions: (q) => client.suggestTags(q) })`. Because the client depends on stored settings, create the picker inside the init IIFE and route earlier interactions through `commitInput()` guards, or (simpler, do this) construct `ClepsydraClient` from `DEFAULT_SETTINGS` synchronously and swap `fetchSuggestions` to close over a mutable `client` variable assigned when settings resolve. Replace the old free-text reads:
- capture click: `picker.commitInput(); const additionalTags = picker.getTags();`
- `renderStatus` in-progress branch: `picker.setTags(status.additionalTags)`; terminal branch: `picker.setTags([])`.
- `renderPhase` disabled toggling: `picker.setDisabled(active)` instead of `additionalInput.disabled = active`.

- [ ] **Step 4: Run the gates** — `cd extension && bun run test && bun run typecheck && bun run lint`.
- [ ] **Step 5: Commit**

```bash
git add extension/src/popup/tag-picker.ts extension/src/popup/tag-picker.test.ts extension/src/popup/popup.html extension/src/popup/popup.ts extension/src/popup/popup.test.ts extension/src/lib/api-client.ts extension/src/lib/__tests__ extension/README.md
git commit -m "feat(extension): tag picker with vault suggestions in the capture popup"
```

---

### Task 6: Content-derived tag suggestions (popup)

**Files:**
- Create: `extension/src/popup/content-suggestions.ts`
- Create: `extension/src/popup/content-suggestions.test.ts`
- Modify: `extension/src/lib/capture-tags.ts` (add exported `currentMonthTag`), `extension/src/background/service-worker.ts` (import it instead of its local copy at lines 52-58)
- Modify: `extension/src/lib/api-client.ts` (`listTags`)
- Modify: `extension/src/popup/popup.html`, `extension/src/popup/popup.ts`
- Test: also update `extension/src/popup/popup.test.ts`, `extension/src/lib/__tests__/capture-tags.test.ts` (or the file's existing test home), `extension/src/lib/__tests__/api-client.test.ts`

**Interfaces:**
- Consumes: `TagPicker.addTag`/`onTagsChanged` from Task 5; full tag list via `GET /api/vault/index/tags` (no `q` → complete list ordered by count desc).
- Produces:

```ts
export interface PageSignals {
	title: string;
	description: string;
	keywords: string[];
}
export function tokenizeSignals(signals: PageSignals): string[];
export function suggestFromVaultTags(
	tokens: readonly string[],
	vaultTags: readonly { tag: string; count: number }[],
	exclude: ReadonlySet<string>,
	cap?: number, // default 6
): string[];
```

- [ ] **Step 1: Write the failing tests.**
  - `tokenizeSignals`: lowercases; splits on non `[a-z0-9+#-]`; drops tokens shorter than 3 chars and stopwords ("the", "and", "for", "with", …); splits comma-separated keywords; dedupes preserving first occurrence. Example: `{title: "The Rust Programming Language", description: "A book about systems programming", keywords: ["rust", "Systems"]}` → `["rust", "programming", "language", "book", "about", …]` minus stopwords — assert exact expected array.
  - `suggestFromVaultTags`: exact token↔tag matches only; ranked by vault `count` descending; entries in `exclude` dropped; capped at `cap`. Example with tags `[{tag:"rust",count:12},{tag:"programming",count:3},{tag:"cooking",count:9}]`, tokens `["rust","programming","language"]`, exclude `{"programming"}` → `["rust"]`… (write the assertions to match).
  - `currentMonthTag` still formats `YYYY-MM` from its new home; the service-worker suite still passes unmodified (import move only).
  - api-client: `listTags()` hits `/api/vault/index/tags` and maps `[{tag, count, computed_count}]` → `[{tag, count}]`.
  - popup: with a fake `scripting.executeScript` returning signals and a fake tag list, suggested-tag buttons render (capped, ranked); clicking one calls `picker.addTag` and hides that button; tags already selected or implicit (`archive`, the tab's domain, current month) never render; `executeScript` failure falls back to tab-title-only signals; a restricted/non-http tab renders no suggestions.
- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement.**

`capture-tags.ts` — move the worker's `currentMonthTag` here verbatim and export it; the worker imports it.

`api-client.ts`:

```ts
	async listTags(): Promise<{ tag: string; count: number }[]> {
		const res = await fetch(`${this.baseUrl}/api/vault/index/tags`);
		if (!res.ok) {
			throw new ArchiveError(`Tag list failed: ${res.status}`);
		}
		const tags: { tag: string; count: number }[] = await res.json();
		return tags.map(({ tag, count }) => ({ tag, count }));
	}
```

`content-suggestions.ts`:

```ts
const STOPWORDS = new Set([
	"the", "and", "for", "with", "that", "this", "from", "your", "you",
	"are", "was", "were", "has", "have", "had", "not", "but", "all",
	"can", "how", "what", "when", "where", "why", "who", "will", "its",
	"about", "into", "over", "under", "more", "less", "than", "then",
	"out", "off", "our", "their", "his", "her", "she", "him", "they",
]);

export interface PageSignals {
	title: string;
	description: string;
	keywords: string[];
}

/** Lowercased, deduped candidate tokens from page metadata. */
export function tokenizeSignals(signals: PageSignals): string[] {
	const raw = [
		signals.title,
		signals.description,
		...signals.keywords.flatMap((keyword) => keyword.split(",")),
	].join(" ");
	const seen = new Set<string>();
	const tokens: string[] = [];
	for (const word of raw.toLowerCase().split(/[^a-z0-9+#-]+/)) {
		if (word.length < 3 || STOPWORDS.has(word) || seen.has(word)) continue;
		seen.add(word);
		tokens.push(word);
	}
	return tokens;
}

/** Vault tags the page's own words point at, ranked by vault usage. */
export function suggestFromVaultTags(
	tokens: readonly string[],
	vaultTags: readonly { tag: string; count: number }[],
	exclude: ReadonlySet<string>,
	cap = 6,
): string[] {
	const tokenSet = new Set(tokens);
	return vaultTags
		.filter(({ tag }) => tokenSet.has(tag) && !exclude.has(tag))
		.sort((a, b) => b.count - a.count)
		.slice(0, cap)
		.map(({ tag }) => tag);
}
```

`popup.html` — between the picker input block and the help line:

```html
    <div id="suggested-tags" class="tag-list" hidden></div>
```

(chips are `<button type="button" class="tag tag-suggested">` so they inherit chip styling; add `.tag-suggested { cursor: pointer; background: none; width: auto; min-height: 0; font-size: inherit; }` to neutralise the global button rules).

`popup.ts` — inside the init IIFE, after the tab is known, not restricted, and http(s):

```ts
async function collectPageSignals(
	tabId: number,
	fallbackTitle: string,
): Promise<PageSignals> {
	const fallback = { title: fallbackTitle, description: "", keywords: [] };
	const scripting = webext.scripting;
	if (!scripting?.executeScript) return fallback;
	try {
		const [result] = await scripting.executeScript({
			target: { tabId },
			func: () => ({
				title: document.title,
				description:
					document
						.querySelector('meta[name="description"]')
						?.getAttribute("content") ?? "",
				keywords: (
					document
						.querySelector('meta[name="keywords"]')
						?.getAttribute("content") ?? ""
				).split(","),
			}),
		});
		return (result?.result as PageSignals | undefined) ?? fallback;
	} catch {
		return fallback;
	}
}
```

Then, best-effort and non-blocking (`.catch(() => {})` like the lookup):
1. `const [signals, vaultTags] = await Promise.all([collectPageSignals(tab.id, tab.title ?? ""), client.listTags()]);`
2. `const implicit = new Set(normalizeCaptureTags(["archive", extractDomainFromUrl(tab.url), currentMonthTag(), ...settings.default_tags]));` — add a tiny local `extractDomainFromUrl` (`new URL(url).hostname` with try/catch), mirroring the worker's.
3. `renderSuggestedTags(suggestFromVaultTags(tokenizeSignals(signals), vaultTags, new Set([...implicit, ...picker.getTags()])))` — renders the buttons; each click calls `picker.addTag(tag)` and removes its button; `picker`'s `onTagsChanged` re-filters the row so a manually typed tag also removes its suggested button; empty result keeps the row hidden.

- [ ] **Step 4: Run the gates** — `cd extension && bun run test && bun run typecheck && bun run lint && bun run build`.
- [ ] **Step 5: Commit**

```bash
git add extension/src/popup/content-suggestions.ts extension/src/popup/content-suggestions.test.ts extension/src/lib/capture-tags.ts extension/src/background/service-worker.ts extension/src/lib/api-client.ts extension/src/lib/__tests__ extension/src/popup/popup.html extension/src/popup/popup.ts extension/src/popup/popup.test.ts
git commit -m "feat(extension): content-derived tag suggestions from vault tags"
```

---

## Final verification (orchestrator)

- [ ] `cargo test` (workspace), `cargo clippy --all-targets`
- [ ] `cd extension && bun run test && bun run typecheck && bun run lint && bun run build`
- [ ] `cd ui && bun run typecheck` (schema regen must not break the app)
- [ ] Confirm `ui/src/api/schema.d.ts` contains the lookup operation; confirm api-reference.mdx heading present
- [ ] Merge `feature/tsk-0086-0087-extension-capture` → `develop` (--no-ff), delete branch
- [ ] Board: TSK-0086 and TSK-0087 → SEALED with checklists ticked; annotate the Stray Thoughts note
