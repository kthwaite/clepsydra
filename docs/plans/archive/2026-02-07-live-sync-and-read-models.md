# Live Sync & Read-Model Emitters Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Connect the existing watcher/sync engine to the React frontend via Server-Sent Events (SSE), and add enriched read-model endpoints (graph, content index) for future UI features.

**Architecture:** A `tokio::sync::broadcast` channel carries `SyncNotification` messages from the sync loop and API mutation handlers to connected SSE clients. The frontend subscribes via `EventSource`, invalidating TanStack Query caches on change. Two new read-model endpoints (`/graph`, `/content-index`) expose enriched index data.

**Tech Stack:** Axum SSE (`axum::response::sse`), `tokio-stream` (BroadcastStream adapter), `tokio::sync::broadcast`, TanStack Query invalidation, EventSource API.

---

### Task 1: SyncNotification type + broadcast channel in AppState

**Files:**
- Create: `src/api/events.rs`
- Modify: `src/api/mod.rs` (add `pub mod events;`, add broadcast sender to AppState)
- Modify: `src/lib.rs` (create broadcast channel, pass to AppState)
- Modify: `Cargo.toml` (add `tokio-stream` dependency)
- Test: `tests/api_test.rs`

**Context:** `AppState` lives in `src/api/mod.rs:15-19`. The `run_server()` function in `src/lib.rs:69-173` constructs `AppState` at line 106. The broadcast channel must be created before `AppState` and passed in.

**Step 1: Write the failing test**

In `tests/api_test.rs`, add:

```rust
#[tokio::test]
async fn sync_notification_serializes_to_json() {
    use clepsydra::api::events::SyncNotification;

    let notif = SyncNotification::IndexChanged {
        upserted: vec!["notes/foo.md".to_string()],
        removed: vec!["archive/old.md".to_string()],
    };
    let json = serde_json::to_string(&notif).unwrap();
    assert!(json.contains("index_changed"));
    assert!(json.contains("notes/foo.md"));
    assert!(json.contains("archive/old.md"));
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test sync_notification_serializes`
Expected: FAIL — `events` module does not exist

**Step 3: Add `tokio-stream` dependency**

In `Cargo.toml`, add to `[dependencies]`:
```toml
tokio-stream = "0.1"
```

**Step 4: Create `src/api/events.rs` with SyncNotification type**

```rust
use serde::Serialize;

/// A notification emitted after the vault index changes.
///
/// Sent over the SSE event stream so connected frontends can
/// invalidate their caches.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SyncNotification {
    /// Pages were created, modified, or removed.
    IndexChanged {
        upserted: Vec<String>,
        removed: Vec<String>,
    },
}
```

**Step 5: Add module to `src/api/mod.rs` and update AppState**

Add `pub mod events;` to the module declarations.

Update `AppState`:
```rust
use tokio::sync::broadcast;
use crate::api::events::SyncNotification;

pub struct AppState {
    pub vault: Vault,
    pub index: Arc<Mutex<VaultIndex>>,
    pub warnings: Mutex<Vec<String>>,
    pub change_tx: broadcast::Sender<SyncNotification>,
}
```

**Step 6: Wire broadcast channel in `src/lib.rs`**

In `run_server()`, before constructing `AppState` (around line 106), create the channel:

```rust
let (change_broadcast_tx, _) = tokio::sync::broadcast::channel::<api::events::SyncNotification>(64);
```

Pass it into `AppState`:
```rust
let state = Arc::new(AppState {
    vault,
    index: Arc::clone(&index),
    warnings: Mutex::new(stats.warnings),
    change_tx: change_broadcast_tx,
});
```

**Step 7: Run test to verify it passes**

Run: `cargo test sync_notification_serializes`
Expected: PASS

**Step 8: Run full test suite + clippy**

Run: `cargo test && cargo clippy`
Expected: All pass, no warnings

**Step 9: Commit**

```bash
git add src/api/events.rs src/api/mod.rs src/lib.rs Cargo.toml Cargo.lock tests/api_test.rs
git commit -m "feat(api): add SyncNotification type and broadcast channel in AppState"
```

---

### Task 2: Sync loop emits notifications after processing events

**Files:**
- Modify: `src/lib.rs` (sync loop broadcasts after `process_events()`)

**Context:** The sync loop is at `src/lib.rs:124-158`. After `SyncEngine::process_events()` returns `Ok(stats)`, we should broadcast a `SyncNotification::IndexChanged` if anything actually changed. The broadcast sender is on `state`, so we need to clone it (or `state` itself) into the spawned task.

**Step 1: Write the failing test**

This is integration-level behavior (watcher → sync → broadcast). Rather than a unit test, we verify correctness by checking compilation and manual inspection. The SSE endpoint test (Task 3) will cover end-to-end.

Skip to implementation.

**Step 2: Modify the sync loop in `src/lib.rs`**

Clone the broadcast sender before the `tokio::spawn`:

```rust
let sync_change_tx = state.change_tx.clone();
```

Inside the sync loop, after the `SyncEngine::process_events()` success branch (where `stats.pages_indexed > 0 || stats.pages_removed > 0`), add:

```rust
// Collect changed paths for notification
let mut upserted: Vec<String> = Vec::new();
let mut removed: Vec<String> = Vec::new();
for ev in &batch {
    match ev {
        ChangeEvent::Upsert(vp) => upserted.push(vp.as_str().to_string()),
        ChangeEvent::Remove(vp) => removed.push(vp.as_str().to_string()),
    }
}
if !upserted.is_empty() || !removed.is_empty() {
    let _ = sync_change_tx.send(
        api::events::SyncNotification::IndexChanged { upserted, removed },
    );
}
```

Note: `send()` returns `Err` if there are no receivers — we ignore this with `let _` since it's expected when no SSE clients are connected.

**Step 3: Run full test suite**

Run: `cargo test && cargo clippy`
Expected: All pass

**Step 4: Commit**

```bash
git add src/lib.rs
git commit -m "feat(sync): broadcast SyncNotification after watcher-driven index updates"
```

---

### Task 3: SSE endpoint (`GET /api/vault/events`)

**Files:**
- Modify: `src/api/events.rs` (add SSE handler)
- Modify: `src/api/mod.rs` (mount route)
- Test: `tests/api_test.rs`

**Context:** Axum provides `axum::response::sse::{Event, Sse}`. The handler subscribes to the broadcast channel via `state.change_tx.subscribe()`, wraps the receiver in `tokio_stream::wrappers::BroadcastStream`, maps events to SSE `Event` objects, and returns `Sse<impl Stream<...>>`. The `BroadcastStream` handles `RecvError::Lagged` by yielding an error — we filter these out.

**Step 1: Write the failing test**

In `tests/api_test.rs`:

```rust
#[tokio::test]
async fn sse_events_endpoint_returns_stream() {
    let app = build_test_app();

    let response = app
        .method(axum::http::Method::GET)
        .path("/api/vault/events")
        .await;

    // SSE endpoint should return 200 with text/event-stream content type
    response.assert_status_ok();
    assert!(response
        .header("content-type")
        .to_str()
        .unwrap()
        .contains("text/event-stream"));
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test sse_events_endpoint`
Expected: FAIL — 404, no route

**Step 3: Implement SSE handler in `src/api/events.rs`**

```rust
use std::convert::Infallible;
use std::sync::Arc;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use serde::Serialize;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;

use super::AppState;

// ... (SyncNotification enum from Task 1) ...

pub async fn event_stream(
    State(state): State<Arc<AppState>>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let rx = state.change_tx.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|result| match result {
        Ok(notification) => {
            let json = serde_json::to_string(&notification).ok()?;
            Some(Ok(Event::default().data(json)))
        }
        Err(_) => None, // skip lagged
    });

    Sse::new(stream).keep_alive(KeepAlive::default())
}
```

**Step 4: Mount route in `src/api/mod.rs`**

Add to `api_router()`:

```rust
.route("/events", axum::routing::get(events::event_stream))
```

**Step 5: Run test to verify it passes**

Run: `cargo test sse_events_endpoint`
Expected: PASS

**Step 6: Run full suite + clippy**

Run: `cargo test && cargo clippy`
Expected: All pass

**Step 7: Commit**

```bash
git add src/api/events.rs src/api/mod.rs tests/api_test.rs
git commit -m "feat(api): add GET /api/vault/events SSE endpoint for live sync"
```

---

### Task 4: API mutation handlers emit notifications

**Files:**
- Modify: `src/api/pages.rs` (create_page, update_page, delete_page, move_page)
- Modify: `src/api/folders.rs` (move_folder)
- Modify: `src/api/index_routes.rs` (create_from_link, rebuild_index)
- Test: `tests/api_test.rs`

**Context:** All mutation handlers currently modify the index but don't broadcast changes. After each successful mutation, we should send a `SyncNotification::IndexChanged` on `state.change_tx`. The file watcher may also detect these changes, but the broadcast from the handler provides immediate notification (the watcher has a 500ms debounce). Duplicate notifications are harmless — the frontend just invalidates caches.

**Step 1: Write the failing test**

In `tests/api_test.rs`:

```rust
#[tokio::test]
async fn create_page_emits_sync_notification() {
    let app = build_test_app();
    let state = app.state(); // or however AppState is accessed in tests
    let mut rx = state.change_tx.subscribe();

    app.method(axum::http::Method::PUT)
        .path("/api/vault/pages/test-notify.md")
        .json(&serde_json::json!({
            "title": "Notify Test",
            "body": "content"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    // Should receive a notification
    let notification = rx.try_recv().unwrap();
    match notification {
        clepsydra::api::events::SyncNotification::IndexChanged { upserted, .. } => {
            assert!(upserted.contains(&"test-notify.md".to_string()));
        }
    }
}
```

Note: The test helper `build_test_app()` needs to provide access to `AppState` so we can subscribe to the broadcast channel. If the current test helper doesn't expose this, adjust accordingly — `axum_test::TestServer` with `IntoTestServerConfig` may be needed, or store a `broadcast::Sender` clone accessible from the test.

**Step 2: Run test to verify it fails**

Run: `cargo test create_page_emits`
Expected: FAIL — no notification sent

**Step 3: Add notification emission to each mutation handler**

In each handler, after the successful index update, add:

```rust
let _ = state.change_tx.send(SyncNotification::IndexChanged {
    upserted: vec![vault_path.as_str().to_string()],
    removed: vec![],
});
```

Handlers to modify:
- `pages.rs::create_page` — upserted: `[path]`
- `pages.rs::update_page` — upserted: `[path]`
- `pages.rs::delete_page` — removed: `[path]`
- `pages.rs::move_page` — upserted: `[destination]`, removed: `[source]`
- `folders.rs::move_folder` — upserted: `[all moved paths]`, removed: `[all old paths]`
- `index_routes.rs::create_from_link` — upserted: `[path]`
- `index_routes.rs::rebuild_index` — broadcast a generic "everything changed" notification

For `delete_page` and `move_page`, which use `MutationPlanner`, extract the relevant paths from the plan's `file_ops` field.

Add import to each file:
```rust
use crate::api::events::SyncNotification;
```

**Step 4: Run test to verify it passes**

Run: `cargo test create_page_emits`
Expected: PASS

**Step 5: Run full suite + clippy**

Run: `cargo test && cargo clippy`
Expected: All pass

**Step 6: Commit**

```bash
git add src/api/pages.rs src/api/folders.rs src/api/index_routes.rs tests/api_test.rs
git commit -m "feat(api): emit SyncNotification from all mutation handlers"
```

---

### Task 5: Frontend — Vite proxy + `useVaultEvents` hook

**Files:**
- Modify: `ui/vite.config.ts` (add API proxy)
- Create: `ui/src/hooks/useVaultEvents.ts`
- Modify: `ui/src/lib/queryClient.ts` (no changes needed, reference only)

**Context:** The Vite dev server runs on port 5173, the Axum server on port 3000. A Vite proxy forwards `/api/**` requests to the backend. The `useVaultEvents` hook opens an `EventSource` to `/api/vault/events` and calls `queryClient.invalidateQueries()` when events arrive. It handles reconnection on disconnect.

**Step 1: Add Vite proxy config**

In `ui/vite.config.ts`, add `server.proxy`:

```typescript
server: {
  proxy: {
    "/api": {
      target: "http://127.0.0.1:3000",
      changeOrigin: true,
    },
  },
},
```

**Step 2: Create `ui/src/hooks/useVaultEvents.ts`**

```typescript
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

interface SyncNotification {
  type: "index_changed";
  upserted: string[];
  removed: string[];
}

export function useVaultEvents(): ConnectionStatus {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    let es: EventSource | null = null;
    let disposed = false;

    function connect() {
      if (disposed) return;
      setStatus("connecting");
      es = new EventSource("/api/vault/events");

      es.onopen = () => {
        if (!disposed) setStatus("connected");
      };

      es.onmessage = (event) => {
        try {
          const data: SyncNotification = JSON.parse(event.data);
          if (data.type === "index_changed") {
            queryClient.invalidateQueries({ queryKey: ["pages"] });
            queryClient.invalidateQueries({ queryKey: ["index"] });
          }
        } catch {
          // ignore malformed events
        }
      };

      es.onerror = () => {
        if (disposed) return;
        setStatus("disconnected");
        es?.close();
        // Reconnect after 3 seconds
        retryTimeoutRef.current = setTimeout(connect, 3000);
      };
    }

    connect();

    return () => {
      disposed = true;
      es?.close();
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    };
  }, [queryClient]);

  return status;
}
```

**Step 3: Verify TypeScript compiles**

Run: `cd ui && bun run typecheck`
Expected: PASS (no type errors)

**Step 4: Commit**

```bash
git add ui/vite.config.ts ui/src/hooks/useVaultEvents.ts
git commit -m "feat(ui): add Vite proxy and useVaultEvents SSE hook"
```

---

### Task 6: Sync status indicator component

**Files:**
- Create: `ui/src/components/SyncIndicator.tsx`
- Modify: `ui/src/routes/__root.tsx` (add indicator to layout)

**Context:** The root layout is in `ui/src/routes/__root.tsx:13-24`. The indicator should be a small dot/icon in the header showing connection status. Use the project's brutalist aesthetic — no rounded corners, hard borders.

**Step 1: Create `ui/src/components/SyncIndicator.tsx`**

```tsx
import { useVaultEvents, type ConnectionStatus } from "#/hooks/useVaultEvents";

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  connected: "Live",
  disconnected: "Disconnected",
};

const STATUS_COLORS: Record<ConnectionStatus, string> = {
  connecting: "bg-muted-foreground",
  connected: "bg-foreground",
  disconnected: "bg-destructive",
};

export function SyncIndicator() {
  const status = useVaultEvents();

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground" title={STATUS_LABELS[status]}>
      <div className={`h-1.5 w-1.5 ${STATUS_COLORS[status]}`} />
      <span className="sr-only">{STATUS_LABELS[status]}</span>
    </div>
  );
}
```

**Step 2: Add to root layout**

In `ui/src/routes/__root.tsx`, import and add `<SyncIndicator />` to the header, before `<ThemeToggle>`:

```tsx
import { SyncIndicator } from "#/components/SyncIndicator";

// In the header:
<header className="flex items-center justify-end gap-3 p-3">
  <SyncIndicator />
  <ThemeToggle className="..." />
</header>
```

**Step 3: Verify TypeScript compiles**

Run: `cd ui && bun run typecheck`
Expected: PASS

**Step 4: Verify build succeeds**

Run: `cd ui && bun run build`
Expected: PASS

**Step 5: Commit**

```bash
git add ui/src/components/SyncIndicator.tsx ui/src/routes/__root.tsx
git commit -m "feat(ui): add SyncIndicator component to root layout"
```

---

### Task 7: Graph endpoint (`GET /api/vault/index/graph`)

**Files:**
- Modify: `src/api/index_routes.rs` (add handler + route)
- Test: `tests/api_test.rs`

**Context:** The graph endpoint returns a JSON object with `nodes` and `edges` arrays, derived from the `pages` and `links` tables in the index. Nodes are pages; edges are resolved links. This powers future graph visualization (D3 force layout).

**Step 1: Write the failing test**

In `tests/api_test.rs`:

```rust
#[tokio::test]
async fn graph_returns_nodes_and_edges() {
    let app = build_test_app();

    // Create two pages that link to each other
    app.method(axum::http::Method::PUT)
        .path("/api/vault/pages/alpha.md")
        .json(&serde_json::json!({
            "title": "Alpha",
            "body": "Link to [[Beta]]"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    app.method(axum::http::Method::PUT)
        .path("/api/vault/pages/beta.md")
        .json(&serde_json::json!({
            "title": "Beta",
            "body": "Link to [[Alpha]]"
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let response = app
        .method(axum::http::Method::GET)
        .path("/api/vault/index/graph")
        .await;

    response.assert_status_ok();
    let body: serde_json::Value = response.json();
    let nodes = body["nodes"].as_array().unwrap();
    let edges = body["edges"].as_array().unwrap();
    assert!(nodes.len() >= 2);
    assert!(!edges.is_empty());

    // Verify node structure
    let node = &nodes[0];
    assert!(node.get("id").is_some());
    assert!(node.get("path").is_some());
    assert!(node.get("title").is_some());
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test graph_returns_nodes`
Expected: FAIL — 404, no route

**Step 3: Add response types and handler**

In `src/api/index_routes.rs`, add:

```rust
#[derive(Debug, Serialize)]
struct GraphResponse {
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
}

#[derive(Debug, Serialize)]
struct GraphNode {
    id: String,
    path: String,
    title: Option<String>,
}

#[derive(Debug, Serialize)]
struct GraphEdge {
    source: String,
    target: String,
    kind: String,
}

async fn graph(State(state): State<Arc<AppState>>) -> Result<Json<GraphResponse>, ApiError> {
    let index = state
        .index
        .lock()
        .map_err(|_| ApiError::internal("index lock poisoned"))?;

    let conn = index.connection();

    // Nodes: all pages
    let mut node_stmt = conn
        .prepare("SELECT id, path, title FROM pages")
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let nodes: Vec<GraphNode> = node_stmt
        .query_map([], |row| {
            Ok(GraphNode {
                id: row.get(0)?,
                path: row.get(1)?,
                title: row.get(2)?,
            })
        })
        .map_err(|e| ApiError::internal(e.to_string()))?
        .filter_map(|r| r.ok())
        .collect();

    // Edges: resolved links only (target_id IS NOT NULL)
    let mut edge_stmt = conn
        .prepare(
            "SELECT source_id, target_id, kind FROM links WHERE target_id IS NOT NULL"
        )
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let edges: Vec<GraphEdge> = edge_stmt
        .query_map([], |row| {
            Ok(GraphEdge {
                source: row.get(0)?,
                target: row.get(1)?,
                kind: row.get(2)?,
            })
        })
        .map_err(|e| ApiError::internal(e.to_string()))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(Json(GraphResponse { nodes, edges }))
}
```

**Step 4: Mount route**

Add to the router in `index_routes.rs`:

```rust
.route("/graph", get(graph))
```

**Step 5: Run test to verify it passes**

Run: `cargo test graph_returns_nodes`
Expected: PASS

**Step 6: Run full suite + clippy**

Run: `cargo test && cargo clippy`
Expected: All pass

**Step 7: Commit**

```bash
git add src/api/index_routes.rs tests/api_test.rs
git commit -m "feat(api): add GET /index/graph endpoint for graph visualization data"
```

---

### Task 8: Content index endpoint (`GET /api/vault/index/content-index`)

**Files:**
- Modify: `src/api/index_routes.rs` (add handler + route)
- Test: `tests/api_test.rs`

**Context:** A Quartz-style content index returns per-page metadata in a single JSON array. Each entry contains: path (slug), title, tags, outgoing link targets, created/updated dates, and a text description (first N characters of body). This powers client-side search, explorer, and static export.

**Step 1: Write the failing test**

In `tests/api_test.rs`:

```rust
#[tokio::test]
async fn content_index_returns_page_details() {
    let app = build_test_app();

    app.method(axum::http::Method::PUT)
        .path("/api/vault/pages/indexed.md")
        .json(&serde_json::json!({
            "title": "Indexed Page",
            "tags": ["rust", "test"],
            "body": "This is the body content for indexing."
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);

    let response = app
        .method(axum::http::Method::GET)
        .path("/api/vault/index/content-index")
        .await;

    response.assert_status_ok();
    let body: Vec<serde_json::Value> = response.json();
    assert!(!body.is_empty());

    let entry = body.iter().find(|e| e["path"] == "indexed.md").unwrap();
    assert_eq!(entry["title"], "Indexed Page");
    assert!(entry["tags"].as_array().unwrap().contains(&serde_json::json!("rust")));
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test content_index_returns`
Expected: FAIL — 404, no route

**Step 3: Add response type and handler**

In `src/api/index_routes.rs`, add:

```rust
#[derive(Debug, Serialize)]
struct ContentEntry {
    path: String,
    title: Option<String>,
    tags: Vec<String>,
    links: Vec<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    description: String,
}

async fn content_index(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<ContentEntry>>, ApiError> {
    let index = state
        .index
        .lock()
        .map_err(|_| ApiError::internal("index lock poisoned"))?;

    let conn = index.connection();

    // Get all pages
    let mut page_stmt = conn
        .prepare("SELECT id, path, title FROM pages")
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let pages: Vec<(String, String, Option<String>)> = page_stmt
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| ApiError::internal(e.to_string()))?
        .filter_map(|r| r.ok())
        .collect();

    let mut entries = Vec::with_capacity(pages.len());

    for (page_id, path, title) in &pages {
        // Tags for this page
        let mut tag_stmt = conn
            .prepare_cached("SELECT tag FROM tags WHERE page_id = ?1")
            .map_err(|e| ApiError::internal(e.to_string()))?;
        let tags: Vec<String> = tag_stmt
            .query_map(params![page_id], |row| row.get(0))
            .map_err(|e| ApiError::internal(e.to_string()))?
            .filter_map(|r| r.ok())
            .collect();

        // Outgoing link targets for this page
        let mut link_stmt = conn
            .prepare_cached(
                "SELECT DISTINCT target_path FROM links WHERE source_id = ?1 AND target_path IS NOT NULL"
            )
            .map_err(|e| ApiError::internal(e.to_string()))?;
        let links: Vec<String> = link_stmt
            .query_map(params![page_id], |row| row.get(0))
            .map_err(|e| ApiError::internal(e.to_string()))?
            .filter_map(|r| r.ok())
            .collect();

        // Read page body for description (first 200 chars)
        let vault_path = match VaultPath::new(path) {
            Ok(vp) => vp,
            Err(_) => continue,
        };
        let abs_path = state.vault.resolve(&vault_path);
        let (created_at, updated_at, description) = if abs_path.exists() {
            match crate::vault::page::Page::from_file(&abs_path, vault_path) {
                Ok(page) => {
                    let desc = page.body.chars().take(200).collect::<String>();
                    let created = page.meta.created_at.map(|d| d.to_rfc3339());
                    let updated = page.meta.updated_at.map(|d| d.to_rfc3339());
                    (created, updated, desc)
                }
                Err(_) => (None, None, String::new()),
            }
        } else {
            (None, None, String::new())
        };

        entries.push(ContentEntry {
            path: path.clone(),
            title: title.clone(),
            tags,
            links,
            created_at,
            updated_at,
            description,
        });
    }

    Ok(Json(entries))
}
```

**Step 4: Mount route**

Add to the router:

```rust
.route("/content-index", get(content_index))
```

**Step 5: Run test to verify it passes**

Run: `cargo test content_index_returns`
Expected: PASS

**Step 6: Run full suite + clippy**

Run: `cargo test && cargo clippy`
Expected: All pass

**Step 7: Commit**

```bash
git add src/api/index_routes.rs tests/api_test.rs
git commit -m "feat(api): add GET /index/content-index endpoint for Quartz-style content index"
```

---

## Summary

| Task | Description | Key Files |
|------|-------------|-----------|
| 1 | SyncNotification type + broadcast channel | `events.rs`, `mod.rs`, `lib.rs` |
| 2 | Sync loop emits notifications | `lib.rs` |
| 3 | SSE endpoint | `events.rs`, `mod.rs` |
| 4 | Mutation handlers emit notifications | `pages.rs`, `folders.rs`, `index_routes.rs` |
| 5 | Vite proxy + useVaultEvents hook | `vite.config.ts`, `useVaultEvents.ts` |
| 6 | Sync status indicator | `SyncIndicator.tsx`, `__root.tsx` |
| 7 | Graph endpoint | `index_routes.rs` |
| 8 | Content index endpoint | `index_routes.rs` |

Tasks 1-4 are backend (Rust). Tasks 5-6 are frontend (TypeScript/React). Tasks 7-8 are backend read-model endpoints. Dependencies: 1→2→3→4 (sequential), 3→5→6 (SSE before frontend), 7 and 8 are independent.
