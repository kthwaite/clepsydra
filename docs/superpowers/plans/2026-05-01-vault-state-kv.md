# Vault State KV Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land an authoritative XDG-shared `state.db` with a typed key/value table, vault-identity via UUID v7, and a first consumer (`LastOpenedTab`) wired end-to-end through HTTP and the React frontend.

**Architecture:** A new module `src/state/` opens a SQLite database at `<XDG_DATA_DIR>/clepsydra/state.db`, runs forward-only `PRAGMA user_version` migrations, and exposes a typed `Meta` API keyed by `VaultId` (a UUID v7 stored in `<vault>/.clepsydra/config.toml`). HTTP layer mounts `GET /api/vault/meta` (typed snapshot) and per-key `PUT/DELETE`. Frontend hooks `useMeta`/`useSetMeta`/`useClearMeta` mirror BCL/location patterns; the workspace store mirrors active-tab path on change and hydrates on cold start.

**Tech Stack:** Rust 2024, rusqlite (bundled, JSON1 enabled), uuid v7, serde_json, axum 0.8, utoipa 5; React 19, TanStack Query, zustand, suncalc-free.

**Spec:** `docs/superpowers/specs/2026-05-01-vault-state-kv-design.md`

---

## File structure

**New (Rust):**
- `src/state/mod.rs` — `StateDb` struct, public API, error type
- `src/state/migrations.rs` — migration runner
- `src/state/migrations/0001_initial.sql` — schema for v1
- `src/state/registry.rs` — `vaults` table operations
- `src/state/meta.rs` — `MetaKey` enum, `MetaSnapshot`, get/set/clear/snapshot
- `src/api/meta.rs` — HTTP handlers
- `tests/state_meta_test.rs` — integration tests

**Modified (Rust):**
- `src/lib.rs` — declare `pub mod state;`, open StateDb in `run_server`
- `src/vault/mod.rs` — UUID upgrade in `Vault::open`, expose `vault_id()`
- `src/vault/config.rs` — add `id: Option<String>` to `VaultConfig`
- `src/api/mod.rs` — declare `pub mod meta;`, route, AppState fields
- `src/api/openapi.rs` — register `meta` paths and schemas
- 10 test fixtures in `tests/*.rs` — extend `AppState` literal with `state` and `vault_id`

**New (frontend):**
- `ui/src/api/meta.ts` — `useMeta`, `useSetMeta`, `useClearMeta`, types
- `ui/src/api/__tests__/meta.test.ts` — vitest for hook cache update

**Modified (frontend):**
- `ui/src/api/keys.ts` — `queryKeys.meta`
- `ui/src/api/schema.d.ts` — regenerated from OpenAPI
- `ui/src/routes/workspace.tsx` — hydrate on cold start, mirror activeTabId to state.db

---

## Phase 1 — `state.db` foundation

### Task 1: Migration runner + initial schema

**Files:**
- Create: `src/state/migrations.rs`
- Create: `src/state/migrations/0001_initial.sql`
- Create: `src/state/mod.rs` (skeleton only — full API in later tasks)

- [ ] **Step 1.1: Write the SQL schema**

Create `src/state/migrations/0001_initial.sql`:

```sql
CREATE TABLE vaults (
    id              TEXT PRIMARY KEY,
    current_path    TEXT NOT NULL,
    display_name    TEXT,
    last_opened_at  INTEGER NOT NULL,
    created_at      INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE vault_meta (
    vault_id    TEXT    NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    key         TEXT    NOT NULL,
    value       TEXT    NOT NULL CHECK (json_valid(value)),
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (vault_id, key)
) WITHOUT ROWID;
```

- [ ] **Step 1.2: Create the module skeleton**

Create `src/state/mod.rs`:

```rust
//! Authoritative, machine-shared state database. See
//! `docs/superpowers/specs/2026-05-01-vault-state-kv-design.md`.

pub mod migrations;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum StateError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, StateError>;
```

- [ ] **Step 1.3: Declare module in lib.rs**

Add to `src/lib.rs` after existing `pub mod` declarations (alphabetical with `vault`):

```rust
pub mod state;
```

- [ ] **Step 1.4: Write the failing migration test**

Create `src/state/migrations.rs`:

```rust
use rusqlite::{Connection, Result as SqliteResult};

const MIGRATIONS: &[&str] = &[
    /* v1 */ include_str!("migrations/0001_initial.sql"),
];

/// Apply all pending migrations in order, idempotently.
///
/// Tracks schema version via `PRAGMA user_version`. Each migration runs in
/// its own transaction; a failure leaves the database at the previous
/// version. Forward-only — no down migrations.
pub fn migrate(conn: &mut Connection) -> SqliteResult<()> {
    let current: u32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let next = (i as u32) + 1;
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", next)?;
        tx.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_memory() -> Connection {
        Connection::open_in_memory().expect("in-memory db")
    }

    #[test]
    fn migrate_creates_tables_on_empty_db() {
        let mut conn = open_memory();
        migrate(&mut conn).expect("migrate");
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('vaults','vault_meta')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn migrate_is_idempotent() {
        let mut conn = open_memory();
        migrate(&mut conn).expect("first");
        migrate(&mut conn).expect("second");
        let v: u32 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, 1);
    }

    #[test]
    fn user_version_advances_to_one() {
        let mut conn = open_memory();
        migrate(&mut conn).expect("migrate");
        let v: u32 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, 1);
    }

    #[test]
    fn vault_meta_rejects_invalid_json() {
        let mut conn = open_memory();
        migrate(&mut conn).expect("migrate");
        // Insert a vault row first so the FK is satisfied.
        conn.execute(
            "INSERT INTO vaults(id, current_path, last_opened_at, created_at) VALUES ('v1', '/tmp', 0, 0)",
            [],
        )
        .unwrap();
        let err = conn.execute(
            "INSERT INTO vault_meta(vault_id, key, value, updated_at) VALUES ('v1','k','not json',0)",
            [],
        );
        assert!(err.is_err(), "expected CHECK constraint failure");
    }
}
```

- [ ] **Step 1.5: Run migration tests — expect PASS**

Run: `cargo test --lib state::migrations -- --nocapture`
Expected: 4 tests pass.

- [ ] **Step 1.6: Commit**

```bash
git add src/state/ src/lib.rs
git commit -m "feat(state): migration runner with v1 schema for state.db"
```

---

### Task 2: `StateDb::open` and basic registry operations

**Files:**
- Create: `src/state/registry.rs`
- Modify: `src/state/mod.rs`

- [ ] **Step 2.1: Define `VaultId` newtype and registry types**

Create `src/state/registry.rs`:

```rust
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

use super::Result;

/// Stable identifier for a vault. Generated as UUID v7 on first open and
/// stored in the vault's `.clepsydra/config.toml`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct VaultId(pub Uuid);

impl VaultId {
    pub fn new_v7() -> Self {
        Self(Uuid::now_v7())
    }

    pub fn as_string(&self) -> String {
        self.0.to_string()
    }
}

impl std::str::FromStr for VaultId {
    type Err = uuid::Error;
    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        Uuid::parse_str(s).map(Self)
    }
}

impl std::fmt::Display for VaultId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// Insert a vault row if absent, otherwise refresh `current_path` and
/// `last_opened_at`. `created_at` is set on first insert and never changes.
pub fn register_vault(conn: &Connection, id: VaultId, path: &Path) -> Result<()> {
    let now = unix_now();
    let path_str = path.to_string_lossy();
    conn.execute(
        "INSERT INTO vaults(id, current_path, last_opened_at, created_at)
         VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT(id) DO UPDATE SET
             current_path = excluded.current_path,
             last_opened_at = excluded.last_opened_at",
        params![id.as_string(), path_str, now],
    )?;
    Ok(())
}

/// Bump `last_opened_at` for an already-registered vault. No-op if the vault
/// is not in the registry.
pub fn touch_last_opened(conn: &Connection, id: VaultId) -> Result<()> {
    conn.execute(
        "UPDATE vaults SET last_opened_at = ?2 WHERE id = ?1",
        params![id.as_string(), unix_now()],
    )?;
    Ok(())
}

/// Look up a vault row by id, returning `(current_path, last_opened_at)` if
/// present.
#[cfg(test)]
pub fn lookup(conn: &Connection, id: VaultId) -> Result<Option<(String, i64)>> {
    Ok(conn
        .query_row(
            "SELECT current_path, last_opened_at FROM vaults WHERE id = ?1",
            params![id.as_string()],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        )
        .optional()?)
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::migrations::migrate;
    use std::path::PathBuf;

    fn open_migrated() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        migrate(&mut c).unwrap();
        c
    }

    #[test]
    fn register_vault_inserts_row() {
        let conn = open_migrated();
        let id = VaultId::new_v7();
        let path = PathBuf::from("/tmp/vault");
        register_vault(&conn, id, &path).unwrap();

        let row = lookup(&conn, id).unwrap().expect("row");
        assert_eq!(row.0, "/tmp/vault");
        assert!(row.1 > 0);
    }

    #[test]
    fn register_vault_updates_path_on_conflict() {
        let conn = open_migrated();
        let id = VaultId::new_v7();
        register_vault(&conn, id, &PathBuf::from("/old/path")).unwrap();
        register_vault(&conn, id, &PathBuf::from("/new/path")).unwrap();

        let row = lookup(&conn, id).unwrap().unwrap();
        assert_eq!(row.0, "/new/path");
    }

    #[test]
    fn touch_last_opened_advances_timestamp() {
        let conn = open_migrated();
        let id = VaultId::new_v7();
        register_vault(&conn, id, &PathBuf::from("/x")).unwrap();
        let t1 = lookup(&conn, id).unwrap().unwrap().1;

        std::thread::sleep(std::time::Duration::from_millis(1100));
        touch_last_opened(&conn, id).unwrap();
        let t2 = lookup(&conn, id).unwrap().unwrap().1;

        assert!(t2 >= t1, "expected t2 ({}) >= t1 ({})", t2, t1);
    }
}
```

- [ ] **Step 2.2: Define `StateDb` and re-export `VaultId`**

Replace contents of `src/state/mod.rs`:

```rust
//! Authoritative, machine-shared state database. See
//! `docs/superpowers/specs/2026-05-01-vault-state-kv-design.md`.

pub mod migrations;
pub mod registry;

use std::path::Path;

use parking_lot::Mutex;
use rusqlite::Connection;
use thiserror::Error;

pub use registry::VaultId;

#[derive(Debug, Error)]
pub enum StateError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, StateError>;

/// Handle to the shared state database.
pub struct StateDb {
    conn: Mutex<Connection>,
}

impl StateDb {
    /// Open `state.db` at `path` (or in-memory if `path == ":memory:"`),
    /// run migrations, and return the handle. Creates parent directories
    /// as needed.
    pub fn open(path: &Path) -> Result<Self> {
        let mut conn = if path.as_os_str() == ":memory:" {
            Connection::open_in_memory()?
        } else {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    StateError::Sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
                })?;
            }
            Connection::open(path)?
        };
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        migrations::migrate(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn register_vault(&self, id: VaultId, path: &Path) -> Result<()> {
        let conn = self.conn.lock();
        registry::register_vault(&conn, id, path)
    }

    pub fn touch_last_opened(&self, id: VaultId) -> Result<()> {
        let conn = self.conn.lock();
        registry::touch_last_opened(&conn, id)
    }

    /// Direct connection access for the meta layer (same crate).
    pub(crate) fn with_conn<R>(&self, f: impl FnOnce(&Connection) -> Result<R>) -> Result<R> {
        let conn = self.conn.lock();
        f(&conn)
    }
}

#[cfg(test)]
impl StateDb {
    pub fn open_in_memory() -> Result<Self> {
        Self::open(Path::new(":memory:"))
    }
}
```

- [ ] **Step 2.3: Run registry tests — expect PASS**

Run: `cargo test --lib state::registry -- --nocapture`
Expected: 3 tests pass.

- [ ] **Step 2.4: Run StateDb open test**

Add to `src/state/mod.rs` at the bottom:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_in_memory_runs_migrations() {
        let db = StateDb::open_in_memory().expect("open");
        let id = VaultId::new_v7();
        db.register_vault(id, std::path::Path::new("/tmp/x"))
            .expect("register");
    }
}
```

Run: `cargo test --lib state -- --nocapture`
Expected: all state tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add src/state/
git commit -m "feat(state): StateDb handle and vault registry operations"
```

---

### Task 3: `MetaKey` enum and meta CRUD

**Files:**
- Create: `src/state/meta.rs`
- Modify: `src/state/mod.rs`

- [ ] **Step 3.1: Write `meta.rs` with `MetaKey`, `MetaSnapshot`, and ops**

Create `src/state/meta.rs`:

```rust
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde::de::DeserializeOwned;
use utoipa::ToSchema;

use super::registry::VaultId;
use super::{Result, StateError};

/// Closed set of metadata keys. Adding a key:
///   1. add a variant here
///   2. extend `as_str` and `all`
///   3. add an `Option<T>` field on `MetaSnapshot`
///   4. extend `MetaSnapshot::collect`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetaKey {
    LastOpenedTab,
}

impl MetaKey {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::LastOpenedTab => "last_opened_tab",
        }
    }

    pub fn all() -> &'static [MetaKey] {
        &[Self::LastOpenedTab]
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "last_opened_tab" => Some(Self::LastOpenedTab),
            _ => None,
        }
    }
}

/// Typed snapshot of all known meta keys for a single vault. Each known
/// `MetaKey` variant becomes one optional field. Unset keys are `None`.
#[derive(Debug, Default, Serialize, Deserialize, ToSchema)]
pub struct MetaSnapshot {
    pub last_opened_tab: Option<String>,
}

pub fn get<T: DeserializeOwned>(
    conn: &Connection,
    id: VaultId,
    key: MetaKey,
) -> Result<Option<T>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM vault_meta WHERE vault_id = ?1 AND key = ?2",
            params![id.as_string(), key.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    match raw {
        Some(s) => Ok(Some(serde_json::from_str(&s)?)),
        None => Ok(None),
    }
}

pub fn set<T: Serialize>(
    conn: &Connection,
    id: VaultId,
    key: MetaKey,
    value: &T,
) -> Result<()> {
    let json = serde_json::to_string(value)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO vault_meta(vault_id, key, value, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(vault_id, key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at",
        params![id.as_string(), key.as_str(), json, now],
    )?;
    Ok(())
}

pub fn clear(conn: &Connection, id: VaultId, key: MetaKey) -> Result<()> {
    conn.execute(
        "DELETE FROM vault_meta WHERE vault_id = ?1 AND key = ?2",
        params![id.as_string(), key.as_str()],
    )?;
    Ok(())
}

pub fn snapshot(conn: &Connection, id: VaultId) -> Result<MetaSnapshot> {
    let mut snap = MetaSnapshot::default();
    let mut stmt = conn.prepare(
        "SELECT key, value FROM vault_meta WHERE vault_id = ?1",
    )?;
    let rows = stmt.query_map(params![id.as_string()], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (k, v) = row?;
        match MetaKey::parse(&k) {
            Some(MetaKey::LastOpenedTab) => {
                snap.last_opened_tab = serde_json::from_str(&v).map_err(StateError::Json).ok();
            }
            None => {
                tracing::warn!(key = %k, "vault_meta row with unknown key — ignoring");
            }
        }
    }
    Ok(snap)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::StateDb;
    use std::path::Path;

    fn fresh_db_with_vault() -> (StateDb, VaultId) {
        let db = StateDb::open_in_memory().unwrap();
        let id = VaultId::new_v7();
        db.register_vault(id, Path::new("/tmp/v")).unwrap();
        (db, id)
    }

    #[test]
    fn meta_key_parse_round_trips_every_variant() {
        for k in MetaKey::all() {
            assert_eq!(MetaKey::parse(k.as_str()), Some(*k));
        }
    }

    #[test]
    fn set_then_get_round_trips_string() {
        let (db, id) = fresh_db_with_vault();
        db.with_conn(|c| set(c, id, MetaKey::LastOpenedTab, &"page:foo".to_string())).unwrap();
        let got: Option<String> =
            db.with_conn(|c| get(c, id, MetaKey::LastOpenedTab)).unwrap();
        assert_eq!(got.as_deref(), Some("page:foo"));
    }

    #[test]
    fn get_returns_none_when_unset() {
        let (db, id) = fresh_db_with_vault();
        let got: Option<String> =
            db.with_conn(|c| get(c, id, MetaKey::LastOpenedTab)).unwrap();
        assert_eq!(got, None);
    }

    #[test]
    fn clear_removes_the_key() {
        let (db, id) = fresh_db_with_vault();
        db.with_conn(|c| set(c, id, MetaKey::LastOpenedTab, &"a".to_string())).unwrap();
        db.with_conn(|c| clear(c, id, MetaKey::LastOpenedTab)).unwrap();
        let got: Option<String> =
            db.with_conn(|c| get(c, id, MetaKey::LastOpenedTab)).unwrap();
        assert_eq!(got, None);
    }

    #[test]
    fn snapshot_returns_all_set_keys() {
        let (db, id) = fresh_db_with_vault();
        db.with_conn(|c| set(c, id, MetaKey::LastOpenedTab, &"x".to_string())).unwrap();
        let snap = db.with_conn(|c| snapshot(c, id)).unwrap();
        assert_eq!(snap.last_opened_tab.as_deref(), Some("x"));
    }

    #[test]
    fn cascade_drops_meta_when_vault_deleted() {
        let (db, id) = fresh_db_with_vault();
        db.with_conn(|c| set(c, id, MetaKey::LastOpenedTab, &"x".to_string())).unwrap();
        db.with_conn(|c| {
            c.execute(
                "DELETE FROM vaults WHERE id = ?1",
                params![id.as_string()],
            )?;
            Ok(())
        }).unwrap();
        let count: i64 = db
            .with_conn(|c| {
                Ok(c.query_row("SELECT count(*) FROM vault_meta", [], |r| r.get(0))?)
            })
            .unwrap();
        assert_eq!(count, 0);
    }
}
```

- [ ] **Step 3.2: Re-export from `mod.rs` and add public methods**

Modify `src/state/mod.rs`. Replace `pub use registry::VaultId;` block with:

```rust
pub use registry::VaultId;

pub mod meta;
pub use meta::{MetaKey, MetaSnapshot};
```

Add methods inside the existing `impl StateDb { ... }` block, after `touch_last_opened`:

```rust
    pub fn get<T: serde::de::DeserializeOwned>(
        &self,
        id: VaultId,
        key: MetaKey,
    ) -> Result<Option<T>> {
        let conn = self.conn.lock();
        meta::get(&conn, id, key)
    }

    pub fn set<T: serde::Serialize>(
        &self,
        id: VaultId,
        key: MetaKey,
        value: &T,
    ) -> Result<()> {
        let conn = self.conn.lock();
        meta::set(&conn, id, key, value)
    }

    pub fn clear(&self, id: VaultId, key: MetaKey) -> Result<()> {
        let conn = self.conn.lock();
        meta::clear(&conn, id, key)
    }

    pub fn snapshot(&self, id: VaultId) -> Result<MetaSnapshot> {
        let conn = self.conn.lock();
        meta::snapshot(&conn, id)
    }
```

- [ ] **Step 3.3: Run meta tests — expect PASS**

Run: `cargo test --lib state::meta -- --nocapture`
Expected: 6 tests pass.

- [ ] **Step 3.4: Commit**

```bash
git add src/state/
git commit -m "feat(state): MetaKey enum and typed get/set/clear/snapshot"
```

---

## Phase 2 — vault identity (UUID upgrade)

### Task 4: Add `id` field to `VaultConfig`

**Files:**
- Modify: `src/vault/config.rs`

- [ ] **Step 4.1: Add the field**

In `src/vault/config.rs`, modify the `VaultConfig` struct (around line 23):

```rust
#[derive(Debug, Clone, Default, Deserialize)]
pub struct VaultConfig {
    /// Stable UUID v7 identifying this vault. `None` until the server
    /// generates one on first open and writes it back.
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub vault: VaultSection,
    #[serde(default)]
    pub academic: AcademicSection,
    #[serde(default)]
    pub archive: ArchiveSection,
}
```

- [ ] **Step 4.2: Write a parsing test**

Append to the `tests` module in `src/vault/config.rs`:

```rust
    #[test]
    fn config_parses_id_field() {
        let tmp = TempDir::new().unwrap();
        let vault_root = tmp.path();
        fs::create_dir_all(vault_root.join(".clepsydra")).unwrap();
        fs::write(
            vault_root.join(".clepsydra/config.toml"),
            r#"id = "01234567-89ab-7cde-8f01-234567890abc""#,
        )
        .unwrap();
        let config = VaultConfig::load(vault_root).unwrap();
        assert_eq!(config.id.as_deref(), Some("01234567-89ab-7cde-8f01-234567890abc"));
    }

    #[test]
    fn config_id_is_none_when_absent() {
        let config = VaultConfig::default();
        assert!(config.id.is_none());
    }
```

- [ ] **Step 4.3: Run config tests — expect PASS**

Run: `cargo test --lib vault::config -- --nocapture`
Expected: all (existing + 2 new) config tests pass.

- [ ] **Step 4.4: Commit**

```bash
git add src/vault/config.rs
git commit -m "feat(vault): add optional id field to VaultConfig"
```

---

### Task 5: Atomic vault config write helper + UUID upgrade

**Files:**
- Modify: `src/vault/config.rs`
- Modify: `src/vault/mod.rs`

- [ ] **Step 5.1: Add atomic-write helper to `config.rs`**

Append to `src/vault/config.rs` *before* the `tests` module:

```rust
impl VaultConfig {
    /// Write or update the `id` field on disk, leaving all other config
    /// keys intact. Uses tempfile + rename for atomicity.
    ///
    /// If `.clepsydra/config.toml` does not exist, creates it with just the
    /// `id` field (other fields will default on subsequent loads).
    pub fn persist_id(vault_root: &Path, id: &str) -> Result<(), Box<dyn std::error::Error>> {
        let dir = vault_root.join(".clepsydra");
        std::fs::create_dir_all(&dir)?;
        let final_path = dir.join("config.toml");

        // Read existing TOML as a generic table so we don't drop unknown keys.
        let mut doc: toml::Table = if final_path.exists() {
            toml::from_str(&std::fs::read_to_string(&final_path)?)?
        } else {
            toml::Table::new()
        };
        doc.insert("id".to_string(), toml::Value::String(id.to_string()));
        let serialized = toml::to_string_pretty(&doc)?;

        let tmp_path = dir.join("config.toml.tmp");
        std::fs::write(&tmp_path, serialized)?;
        std::fs::rename(&tmp_path, &final_path)?;
        Ok(())
    }
}
```

Add `toml = { version = "0.8", features = ["preserve_order"] }` *only if* the existing dep doesn't already enable serialization — check `Cargo.toml`. The current `toml = "0.8"` should serialize fine; no change needed unless tests fail.

- [ ] **Step 5.2: Write the persist test**

Add to the `tests` module in `src/vault/config.rs`:

```rust
    #[test]
    fn persist_id_writes_field_atomically() {
        let tmp = TempDir::new().unwrap();
        VaultConfig::persist_id(tmp.path(), "01234567-89ab-7cde-8f01-234567890abc").unwrap();
        let config = VaultConfig::load(tmp.path()).unwrap();
        assert_eq!(
            config.id.as_deref(),
            Some("01234567-89ab-7cde-8f01-234567890abc")
        );
    }

    #[test]
    fn persist_id_preserves_other_fields() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join(".clepsydra")).unwrap();
        fs::write(
            tmp.path().join(".clepsydra/config.toml"),
            r#"
[archive]
enabled = false
cas_path = "/custom/cas"
"#,
        )
        .unwrap();

        VaultConfig::persist_id(tmp.path(), "abc").unwrap();
        let config = VaultConfig::load(tmp.path()).unwrap();
        assert_eq!(config.id.as_deref(), Some("abc"));
        assert!(!config.archive.enabled);
        assert_eq!(config.archive.cas_path, "/custom/cas");
    }
```

- [ ] **Step 5.3: Run new persist tests — expect PASS**

Run: `cargo test --lib vault::config::tests::persist -- --nocapture`
Expected: 2 new tests pass.

- [ ] **Step 5.4: Wire UUID upgrade into `Vault::open`**

In `src/vault/mod.rs`, modify the existing `Vault::open` (lines 53–67) and add a `vault_id()` getter:

```rust
use crate::state::VaultId;

#[derive(Clone)]
pub struct Vault {
    root: PathBuf,
    config: VaultConfig,
    exclusion_patterns: Vec<glob::Pattern>,
    id: VaultId,
}

impl Vault {
    pub fn open(root: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let root = root.canonicalize()?;
        let mut config = VaultConfig::load(&root)?;

        // Generate and persist a UUID v7 if the vault has no id yet.
        let id = match config.id.as_deref() {
            Some(s) => s.parse::<VaultId>()
                .map_err(|e| format!("vault config has malformed id: {e}"))?,
            None => {
                let new_id = VaultId::new_v7();
                VaultConfig::persist_id(&root, &new_id.to_string())?;
                config.id = Some(new_id.to_string());
                new_id
            }
        };

        let exclusion_patterns = config
            .vault
            .excluded_patterns
            .iter()
            .map(|p| glob::Pattern::new(p))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            root,
            config,
            exclusion_patterns,
            id,
        })
    }

    pub fn id(&self) -> VaultId {
        self.id
    }

    // ... (rest unchanged: resolve, is_excluded, root, config)
}
```

- [ ] **Step 5.5: Write the upgrade test**

Append to `src/vault/mod.rs` (add a `tests` module if absent):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn open_generates_and_persists_id_when_absent() {
        let tmp = TempDir::new().unwrap();
        let vault = Vault::open(tmp.path()).unwrap();
        let id1 = vault.id();
        drop(vault);

        // Re-open: id should be the same.
        let vault2 = Vault::open(tmp.path()).unwrap();
        assert_eq!(vault2.id(), id1, "id should persist across opens");
    }

    #[test]
    fn open_uses_existing_id_when_present() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".clepsydra")).unwrap();
        std::fs::write(
            tmp.path().join(".clepsydra/config.toml"),
            r#"id = "01234567-89ab-7cde-8f01-234567890abc""#,
        )
        .unwrap();
        let vault = Vault::open(tmp.path()).unwrap();
        assert_eq!(
            vault.id().to_string(),
            "01234567-89ab-7cde-8f01-234567890abc"
        );
    }
}
```

- [ ] **Step 5.6: Run vault tests — expect PASS**

Run: `cargo test --lib vault -- --nocapture`
Expected: all vault tests pass, including 2 new ones.

- [ ] **Step 5.7: Commit**

```bash
git add src/vault/
git commit -m "feat(vault): generate and persist UUID v7 identity on Vault::open"
```

---

## Phase 3 — `AppState` wiring

### Task 6: Add `state` and `vault_id` to `AppState`

**Files:**
- Modify: `src/api/mod.rs`
- Modify: `src/lib.rs`
- Modify: 10 test fixtures

- [ ] **Step 6.1: Extend `AppState`**

In `src/api/mod.rs`, modify the `AppState` struct:

```rust
pub struct AppState {
    pub vault: Vault,
    pub vault_id: crate::state::VaultId,
    pub state: Option<Arc<crate::state::StateDb>>,
    pub index: IndexHandle,
    pub cas: Arc<parking_lot::Mutex<ContentStore>>,
    pub warnings: parking_lot::Mutex<Vec<String>>,
    pub change_tx: broadcast::Sender<SyncNotification>,
    pub hooks: Arc<Vec<Box<dyn crate::vault::hooks::PostMoveHook>>>,
    pub delete_hooks: Arc<Vec<Box<dyn crate::vault::hooks::PostDeleteHook>>>,
    pub archive_ingest_lock: tokio::sync::Mutex<()>,
    pub bcl: Option<chrono::NaiveDate>,
    pub location: Option<crate::vault::location::Location>,
}
```

- [ ] **Step 6.2: Open `state.db` in `run_server`**

In `src/lib.rs`, locate the section after `let location = vault::location::load_or_seed(...)` (~line 333) and add:

```rust
    // Open the authoritative state DB at <XDG_DATA_DIR>/clepsydra/state.db.
    // `Option` so failures (no data dir, permission errors) degrade gracefully.
    let state_db = match dirs::data_dir() {
        Some(dir) => {
            let path = dir.join("clepsydra").join("state.db");
            match crate::state::StateDb::open(&path) {
                Ok(db) => {
                    let arc = std::sync::Arc::new(db);
                    if let Err(e) = arc.register_vault(vault.id(), vault.root()) {
                        tracing::warn!(error = %e, "failed to register vault in state.db");
                    }
                    Some(arc)
                }
                Err(e) => {
                    tracing::warn!(error = %e, path = %path.display(), "failed to open state.db; meta features disabled");
                    None
                }
            }
        }
        None => {
            tracing::warn!("no data dir available; meta features disabled");
            None
        }
    };

    let vault_id = vault.id();
```

Then in the `AppState { ... }` literal a few lines below, add the new fields:

```rust
    let state = Arc::new(AppState {
        vault,
        vault_id,
        state: state_db,
        index: index_handle.clone(),
        // ... rest unchanged
        bcl,
        location,
    });
```

- [ ] **Step 6.3: Update test fixtures**

For each test file, update the `AppState { ... }` literal to add `vault_id` and `state` fields. The `vault_id` reads from `vault.id()`; `state: None` for graceful disable in tests.

For `tests/api_test.rs` (5 occurrences), `tests/api_journal_test.rs`, `tests/api_tasks_test.rs`, `tests/archive_test.rs`, `tests/api_agenda_test.rs`, `tests/e2e_test.rs`, `tests/api_blocks_test.rs`, `tests/e2e_block_refs_test.rs`, `tests/e2e_tasks_journal_test.rs`, `tests/block_ref_resolution_test.rs`:

Find each block:
```rust
        bcl: None,
        location: None,
    });
```

Replace with:
```rust
        bcl: None,
        location: None,
        vault_id: vault.id(),
        state: None,
    });
```

(Order of fields in a struct literal does not matter; placing the new ones at the end keeps diffs minimal.)

- [ ] **Step 6.4: Run all tests — expect PASS**

Run: `cargo test --quiet`
Expected: all tests pass; build succeeds.

- [ ] **Step 6.5: Commit**

```bash
git add src/api/mod.rs src/lib.rs tests/
git commit -m "feat(api): wire state.db and vault_id into AppState"
```

---

## Phase 4 — HTTP API

### Task 7: `meta.rs` handlers

**Files:**
- Create: `src/api/meta.rs`
- Modify: `src/api/mod.rs`
- Modify: `src/api/openapi.rs`

- [ ] **Step 7.1: Write the handler module**

Create `src/api/meta.rs`:

```rust
//! Meta endpoints. See spec §6.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde_json::Value;

use super::AppState;
use super::error::ApiError;
use crate::state::{MetaKey, MetaSnapshot};

#[utoipa::path(
    get,
    path = "/meta",
    context_path = "/api/vault",
    tag = "Meta",
    responses(
        (status = 200, description = "Snapshot of all known meta keys", body = MetaSnapshot),
        (status = 503, description = "state.db unavailable", body = ApiError),
    )
)]
pub async fn get_meta(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MetaSnapshot>, ApiError> {
    let Some(db) = state.state.as_ref() else {
        return Err(ApiError::service_unavailable("state_unavailable"));
    };
    let snap = db.snapshot(state.vault_id).map_err(|e| {
        tracing::error!(error = %e, "snapshot failed");
        ApiError::internal("snapshot_failed")
    })?;
    Ok(Json(snap))
}

#[utoipa::path(
    put,
    path = "/meta/{key}",
    context_path = "/api/vault",
    tag = "Meta",
    params(
        ("key" = String, Path, description = "Meta key (one of: last_opened_tab)")
    ),
    request_body(content = Value, description = "JSON value for the key"),
    responses(
        (status = 204, description = "Value stored"),
        (status = 400, description = "Unknown key or type mismatch", body = ApiError),
        (status = 503, description = "state.db unavailable", body = ApiError),
    )
)]
pub async fn put_meta(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
    Json(value): Json<Value>,
) -> Result<StatusCode, ApiError> {
    let Some(db) = state.state.as_ref() else {
        return Err(ApiError::service_unavailable("state_unavailable"));
    };
    let key = MetaKey::parse(&key).ok_or_else(|| ApiError::bad_request("unknown_key"))?;

    // Per-key type validation: each MetaKey variant has a declared value
    // type. Mismatches return 400 with type_mismatch.
    match key {
        MetaKey::LastOpenedTab => {
            if !value.is_string() {
                return Err(ApiError::bad_request("type_mismatch"));
            }
        }
    }

    db.set(state.vault_id, key, &value).map_err(|e| {
        tracing::error!(error = %e, "set failed");
        ApiError::internal("set_failed")
    })?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    delete,
    path = "/meta/{key}",
    context_path = "/api/vault",
    tag = "Meta",
    params(("key" = String, Path, description = "Meta key")),
    responses(
        (status = 204, description = "Key cleared (idempotent)"),
        (status = 400, description = "Unknown key", body = ApiError),
        (status = 503, description = "state.db unavailable", body = ApiError),
    )
)]
pub async fn delete_meta(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
) -> Result<StatusCode, ApiError> {
    let Some(db) = state.state.as_ref() else {
        return Err(ApiError::service_unavailable("state_unavailable"));
    };
    let key = MetaKey::parse(&key).ok_or_else(|| ApiError::bad_request("unknown_key"))?;
    db.clear(state.vault_id, key).map_err(|e| {
        tracing::error!(error = %e, "clear failed");
        ApiError::internal("clear_failed")
    })?;
    Ok(StatusCode::NO_CONTENT)
}
```

Note: `ApiError` is a struct (see `src/api/error.rs`), with constructor methods `not_found/conflict/bad_request/forbidden/internal`. It does **not** have `service_unavailable` yet — Step 7.2 adds it.

- [ ] **Step 7.2: Add `service_unavailable` constructor to `ApiError`**

In `src/api/error.rs`, add a new constructor next to `internal`:

```rust
    pub fn service_unavailable(msg: impl Into<String>) -> Self {
        Self {
            status: 503,
            error: msg.into(),
            detail: None,
            hint: None,
        }
    }
```

The existing `IntoResponse` impl maps `self.status` → HTTP status code, so 503 is handled automatically.

- [ ] **Step 7.3: Wire route and module declaration**

In `src/api/mod.rs`, add to the module list:

```rust
pub mod meta;
```

Add to the router (after the `/location` route):

```rust
        .route("/meta", axum::routing::get(meta::get_meta))
        .route(
            "/meta/{key}",
            axum::routing::put(meta::put_meta).delete(meta::delete_meta),
        )
```

- [ ] **Step 7.4: Register in `openapi.rs`**

In `src/api/openapi.rs`:

Add tag (after `Location`):
```rust
        (name = "Meta", description = "Vault meta key/value store")
```

Add paths (after `crate::api::location::get_location`):
```rust
        crate::api::location::get_location,
        // Meta
        crate::api::meta::get_meta,
        crate::api::meta::put_meta,
        crate::api::meta::delete_meta
```

Add schemas (after `crate::api::location::LocationResponse`):
```rust
        crate::api::location::LocationResponse,
        // Meta
        crate::state::MetaSnapshot
```

(`ApiError` is already registered as a shared schema; no need to re-add.)

- [ ] **Step 7.5: Build and verify**

Run: `cargo build --tests`
Expected: builds cleanly.

Run: `cargo test --quiet`
Expected: all existing tests still pass.

- [ ] **Step 7.6: Commit**

```bash
git add src/api/
git commit -m "feat(api): GET/PUT/DELETE /api/vault/meta endpoints"
```

---

### Task 8: Integration test for meta endpoints

**Files:**
- Create: `tests/state_meta_test.rs`

- [ ] **Step 8.1: Write the integration test**

Create `tests/state_meta_test.rs`. Use the existing `tests/api_test.rs` as a reference for the `AppState` fixture style:

```rust
use std::sync::Arc;

use axum::Router;
use axum_test::TestServer;
use clepsydra::api::{AppState, api_router};
use clepsydra::state::StateDb;
use clepsydra::vault::Vault;
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::index_handle::IndexHandle;
use serde_json::json;
use tempfile::TempDir;
use tokio::sync::broadcast;

fn production_hooks() -> Arc<Vec<Box<dyn clepsydra::vault::hooks::PostMoveHook>>> {
    Arc::new(vec![Box::new(clepsydra::vault::academic_hook::AcademicMoveHook)])
}

async fn setup() -> (TestServer, TempDir) {
    let tmp = TempDir::new().unwrap();
    let vault = Vault::open(tmp.path()).unwrap();
    let cas_dir = TempDir::new().unwrap();
    let cas = clepsydra::vault::cas::ContentStore::open(cas_dir.path()).unwrap();
    let index = VaultIndex::open(&tmp.path().join(".clepsydra/cache.db")).unwrap();
    let index_handle = IndexHandle::spawn(index, vault.clone());
    let (change_tx, _) = broadcast::channel(64);

    let state_db = Arc::new(StateDb::open_in_memory().unwrap());
    state_db.register_vault(vault.id(), vault.root()).unwrap();

    let vault_id = vault.id();
    let state = Arc::new(AppState {
        vault,
        vault_id,
        state: Some(state_db),
        index: index_handle,
        cas: Arc::new(parking_lot::Mutex::new(cas)),
        warnings: parking_lot::Mutex::new(Vec::new()),
        change_tx,
        hooks: production_hooks(),
        delete_hooks: Arc::new(vec![]),
        archive_ingest_lock: tokio::sync::Mutex::new(()),
        bcl: None,
        location: None,
    });

    let app: Router = Router::new()
        .nest("/api/vault", api_router())
        .with_state(state);
    (TestServer::new(app).unwrap(), tmp)
}

#[tokio::test]
async fn get_meta_returns_empty_snapshot_initially() {
    let (server, _tmp) = setup().await;
    let res = server.get("/api/vault/meta").await;
    res.assert_status_ok();
    res.assert_json(&json!({ "last_opened_tab": null }));
}

#[tokio::test]
async fn put_then_get_round_trips_last_opened_tab() {
    let (server, _tmp) = setup().await;
    server
        .put("/api/vault/meta/last_opened_tab")
        .json(&json!("page:foo.md"))
        .await
        .assert_status(axum::http::StatusCode::NO_CONTENT);

    let res = server.get("/api/vault/meta").await;
    res.assert_status_ok();
    res.assert_json(&json!({ "last_opened_tab": "page:foo.md" }));
}

#[tokio::test]
async fn delete_clears_the_key() {
    let (server, _tmp) = setup().await;
    server
        .put("/api/vault/meta/last_opened_tab")
        .json(&json!("x"))
        .await;
    server
        .delete("/api/vault/meta/last_opened_tab")
        .await
        .assert_status(axum::http::StatusCode::NO_CONTENT);
    let res = server.get("/api/vault/meta").await;
    res.assert_json(&json!({ "last_opened_tab": null }));
}

#[tokio::test]
async fn put_unknown_key_returns_400() {
    let (server, _tmp) = setup().await;
    let res = server
        .put("/api/vault/meta/nonsense_key")
        .json(&json!("x"))
        .await;
    res.assert_status(axum::http::StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn put_type_mismatch_returns_400() {
    let (server, _tmp) = setup().await;
    let res = server
        .put("/api/vault/meta/last_opened_tab")
        .json(&json!(123))
        .await;
    res.assert_status(axum::http::StatusCode::BAD_REQUEST);
}
```

- [ ] **Step 8.2: Run integration tests — expect PASS**

Run: `cargo test --test state_meta_test -- --nocapture`
Expected: 5 tests pass.

- [ ] **Step 8.3: Commit**

```bash
git add tests/state_meta_test.rs
git commit -m "test(api): integration tests for meta endpoints"
```

---

### Task 9: Regenerate frontend OpenAPI schema

**Files:**
- Modify: `ui/src/api/schema.d.ts`

- [ ] **Step 9.1: Start the dev server**

Run: `cargo run -- serve &`
Wait until you see `listening (HTTP) addr=127.0.0.1:16667`.

- [ ] **Step 9.2: Regenerate**

Run: `cd ui && bun run openapi`
Expected: `src/api/schema.d.ts` updated with `MetaSnapshot`, `MetaError`, and `/meta` paths.

- [ ] **Step 9.3: Stop the dev server**

Run: `kill %1` (or `pkill -f 'clepsydra.*serve'`).

- [ ] **Step 9.4: Verify the schema includes the new types**

Run: `grep -n "MetaSnapshot\|/meta" ui/src/api/schema.d.ts`
Expected: at least three matches (path entry + schema component + ref usage).

- [ ] **Step 9.5: Commit**

```bash
git add ui/src/api/schema.d.ts
git commit -m "chore(ui): regenerate OpenAPI schema for meta endpoints"
```

---

## Phase 5 — Frontend

### Task 10: `useMeta`/`useSetMeta`/`useClearMeta` hooks

**Files:**
- Modify: `ui/src/api/keys.ts`
- Create: `ui/src/api/meta.ts`

- [ ] **Step 10.1: Add the query key**

In `ui/src/api/keys.ts`, add after the `location` block:

```ts
  meta: {
    snapshot: ["meta"] as const,
  },
```

- [ ] **Step 10.2: Write the hooks module**

Create `ui/src/api/meta.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "./keys";

/**
 * Vault-bound runtime state. See
 * `docs/superpowers/specs/2026-05-01-vault-state-kv-design.md`.
 *
 * Rule of thumb: if state describes the vault (recent searches inside this
 * vault, pinned folios, last-opened tab) → useMeta. If it describes how the
 * user prefers the app to behave (theme, font scale, dismissed banners) →
 * localStorage.
 */
export interface MetaSnapshot {
  last_opened_tab?: string | null;
}

export function useMeta() {
  return useQuery<MetaSnapshot>({
    queryKey: queryKeys.meta.snapshot,
    queryFn: async () => {
      const res = await fetch("/api/vault/meta");
      if (res.status === 503) {
        // state.db unavailable — degrade gracefully to an empty snapshot.
        return {};
      }
      if (!res.ok) throw new Error("Failed to fetch meta");
      return res.json();
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useSetMeta() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async <K extends keyof MetaSnapshot>(args: {
      key: K;
      value: NonNullable<MetaSnapshot[K]>;
    }) => {
      const res = await fetch(`/api/vault/meta/${args.key}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args.value),
      });
      if (!res.ok) throw new Error(`Failed to set meta.${args.key}`);
    },
    onSuccess: (_, { key, value }) => {
      qc.setQueryData<MetaSnapshot>(queryKeys.meta.snapshot, (prev) => ({
        ...(prev ?? {}),
        [key]: value,
      }));
    },
  });
}

export function useClearMeta() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (key: keyof MetaSnapshot) => {
      const res = await fetch(`/api/vault/meta/${key}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Failed to clear meta.${String(key)}`);
    },
    onSuccess: (_, key) => {
      qc.setQueryData<MetaSnapshot>(queryKeys.meta.snapshot, (prev) => {
        const next = { ...(prev ?? {}) };
        delete next[key];
        return next;
      });
    },
  });
}
```

- [ ] **Step 10.3: Write a vitest for the hooks**

Create `ui/src/api/__tests__/meta.test.ts`:

```ts
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useMeta, useSetMeta } from "../meta";

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useMeta + useSetMeta", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("set updates cache without refetch", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ last_opened_tab: null }), { status: 200 }),
    );

    const meta = renderHook(() => useMeta(), { wrapper: wrapper(client) });
    await waitFor(() => expect(meta.result.current.isSuccess).toBe(true));
    expect(meta.result.current.data?.last_opened_tab).toBeNull();

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const set = renderHook(() => useSetMeta(), { wrapper: wrapper(client) });
    await act(async () => {
      await set.result.current.mutateAsync({ key: "last_opened_tab", value: "page:foo" });
    });

    expect(meta.result.current.data?.last_opened_tab).toBe("page:foo");
    // Two fetches total: one GET on initial, one PUT for set.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
```

(Note: this test file uses JSX-in-TS — confirm the project's vitest setup supports `.tsx` if needed; rename to `.test.tsx` if so.)

- [ ] **Step 10.4: Run the test — expect PASS**

Run: `cd ui && bun run test ui/src/api/__tests__/meta.test.ts`
Expected: 1 test passes.

- [ ] **Step 10.5: Commit**

```bash
git add ui/src/api/keys.ts ui/src/api/meta.ts ui/src/api/__tests__/meta.test.ts
git commit -m "feat(ui): useMeta/useSetMeta/useClearMeta hooks"
```

---

### Task 11: Wire `LastOpenedTab` into the workspace route

**Files:**
- Modify: `ui/src/routes/workspace.tsx`

The workspace route component is the right place: it's the entry point for the tab UI and mounts exactly once per workspace navigation. Hydration runs on first mount, mirror runs on every `activeTabId` change.

- [ ] **Step 11.1: Add hydration and mirror effects**

In `ui/src/routes/workspace.tsx`, add the meta hooks and effects to the existing `Workspace` function. Full updated file:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useMeta, useSetMeta } from "#/api/meta";
import { TabContent } from "#/components/TabContent";
import { useWorkspaceStore } from "#/store/workspace";

export const Route = createFileRoute("/workspace")({
  component: Workspace,
});

function Workspace() {
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const activateTab = useWorkspaceStore((s) => s.activateTab);
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const openTab = useWorkspaceStore((s) => s.openTab);

  const { data: meta } = useMeta();
  const setMeta = useSetMeta();
  const hydratedRef = useRef(false);

  // Hydrate from state.db on first mount: if zustand-persisted tabs are
  // empty and state.db carries a last_opened_tab, open it. The ref guard
  // ensures we never re-hydrate after the user explicitly closes all tabs.
  useEffect(() => {
    if (hydratedRef.current) return;
    if (!meta) return;
    hydratedRef.current = true;
    if (tabs.length === 0 && meta.last_opened_tab) {
      const value = meta.last_opened_tab;
      if (value === "graph") {
        openTab("graph");
      } else if (value.startsWith("page:")) {
        const path = value.slice("page:".length);
        if (path) openTab("page", path, path);
      }
    }
  }, [meta, tabs.length, openTab]);

  // Mirror the active tab's path/sentinel → state.db on every change.
  // setMeta is intentionally omitted from deps (stable mutation handle).
  useEffect(() => {
    if (!activeTabId) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return;
    const value = tab.type === "graph" ? "graph" : `page:${tab.path ?? ""}`;
    setMeta.mutate({ key: "last_opened_tab", value });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, tabs]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "w") {
        e.preventDefault();
        const { activeTabId } = useWorkspaceStore.getState();
        if (activeTabId) closeTab(activeTabId);
      }

      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        const { tabs, activeTabId } = useWorkspaceStore.getState();
        if (tabs.length < 2) return;
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        const next = e.shiftKey
          ? (idx - 1 + tabs.length) % tabs.length
          : (idx + 1) % tabs.length;
        activateTab(tabs[next].id);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeTab, activateTab]);

  return <TabContent />;
}
```

- [ ] **Step 11.2: Build and typecheck**

Run: `cd ui && bun run typecheck`
Expected: no type errors.

Run: `cd ui && bun run lint`
Expected: clean.

- [ ] **Step 11.3: Commit**

```bash
git add ui/src/routes/workspace.tsx
git commit -m "feat(ui): mirror active tab to state.db, hydrate on cold start"
```

---

## Phase 6 — End-to-end smoke

### Task 12: Manual smoke test

- [ ] **Step 12.1: Build everything**

Run: `cargo build && cd ui && bun run build && cd ..`
Expected: clean build.

- [ ] **Step 12.2: Run the server**

Run: `cargo run -- serve`
Wait until "listening (HTTP)".

- [ ] **Step 12.3: Verify state.db was created**

Run (in another terminal): `ls -la "$(dirs --data | head -1 || echo "$HOME/.local/share")/clepsydra/" 2>/dev/null || ls -la ~/Library/Application\ Support/clepsydra/`
Expected: `state.db` exists.

Run: `sqlite3 "$HOME/Library/Application Support/clepsydra/state.db" ".tables"` (macOS) or the Linux equivalent.
Expected: `vault_meta  vaults`.

- [ ] **Step 12.4: Hit the meta endpoint**

Run: `curl -s http://localhost:16667/api/vault/meta`
Expected: `{"last_opened_tab":null}`.

- [ ] **Step 12.5: Set, read, delete**

```bash
curl -X PUT -H 'Content-Type: application/json' -d '"page:test.md"' http://localhost:16667/api/vault/meta/last_opened_tab
curl -s http://localhost:16667/api/vault/meta
curl -X DELETE http://localhost:16667/api/vault/meta/last_opened_tab
curl -s http://localhost:16667/api/vault/meta
```
Expected: 204, `{"last_opened_tab":"page:test.md"}`, 204, `{"last_opened_tab":null}`.

- [ ] **Step 12.6: Open the UI, navigate tabs, kill the server, restart, open in a fresh browser profile**

In Chrome/Firefox: open a private/incognito window (so localStorage is fresh). Navigate to the workspace, open a folio. Kill the server (Ctrl-C). Restart with `cargo run -- serve`. Open the UI again in the same private window. Verify the previously-opened folio is restored from `state.db` (since localStorage was wiped on private-window close, `state.db` is the only source of `last_opened_tab`).

- [ ] **Step 12.7: Verify no clippy regressions**

Run: `cargo clippy --all-targets --quiet`
Expected: no new warnings in `src/state/`, `src/api/meta.rs`, or modified files.

- [ ] **Step 12.8: Final commit (if any cleanup needed)**

If steps 12.1–12.7 surfaced minor issues, fix and commit. Otherwise nothing to commit.

```bash
git status
```

---

## Notes for the implementer

- `tracing::warn!` is the convention for non-fatal failures (matches BCL/location).
- Forward-only migrations: never modify `0001_initial.sql` after it ships. Schema changes go in `0002_*.sql`.
- The `#[cfg(test)] StateDb::open_in_memory()` constructor is the canonical way to spin up a `StateDb` in tests; don't open temp files unless you specifically need disk persistence.
- The workspace store's zustand `persist` middleware writes synchronously to localStorage; the `state.db` mirror is fire-and-forget. Brief inconsistencies between the two are acceptable — last write wins, and the design accepts last-write-wins (spec §1, non-goals).
- If `cargo run -- serve` fails to find `config.toml` (the project's existing convention requires one in cwd or `~/.config/clepsydra/`), provide one before running step 12.2. See `app_config.rs` for resolution rules.
