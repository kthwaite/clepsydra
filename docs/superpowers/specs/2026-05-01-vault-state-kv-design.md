# Vault State KV Table

**Date:** 2026-05-01
**Status:** Design approved, pending implementation

---

## 1) Scope

### In scope

- A new authoritative SQLite database, `state.db`, stored at the user's XDG data directory (resolved via `dirs::data_dir()`), shared across all vaults on the machine.
- A `vaults` registry table mapping vault UUIDs to their last-known filesystem path and operational metadata.
- A `vault_meta` key/value table for per-vault, runtime-mutable UI ambient state.
- Vault identity: a UUID v7 stored in `<vault>/.clepsydra/config.toml`, generated on first open.
- A typed Rust API (`StateDb`, `MetaKey` enum, generic `get<T>/set<T>`) and an HTTP API (`GET /api/vault/meta`, `PUT/DELETE /api/vault/meta/:key`).
- A frontend `useMeta` / `useSetMeta` / `useClearMeta` hook trio.
- A first concrete consumer to prove the path end-to-end: `MetaKey::LastOpenedTab` wired into the existing tab system.
- A hand-rolled, forward-only migration runner using `PRAGMA user_version`.

### Explicitly out of scope

- **Per-page state table** (`last_visited_at`, pinned, color). Different shape; deferred to a separate design.
- **Vault config consolidation** (collapsing `bcl`, `location.toml`, future fields into one TOML). Separate change.
- **Multi-tab / multi-client meta sync.** Last write wins. SSE-based change events are a future addition if needed.
- **Settings UI.** No general settings panel. Components own their own state via `useSetMeta`.
- **Vault registry browsing API.** The `vaults` table is populated but not exposed; clepsydra still serves one vault per process.
- **Migration rollback.** Forward-only.
- **CLI subcommand for state.db inspection.** `sqlite3` is sufficient.
- **Browser-bound preferences** (theme, font scale, dismissed banners). Those stay in `localStorage`; this spec only documents the boundary.

---

## 2) Storage layout

### Two databases, two responsibilities

| File | Path | Authority |
|------|------|-----------|
| `cache.db` | `<vault>/.clepsydra/cache.db` | **Derivative.** Rebuildable from the filesystem. Existing — unchanged by this spec. |
| `state.db` | `<XDG_DATA_DIR>/clepsydra/state.db` | **Authoritative.** Machine-shared across all vaults. Versioned. User backs it up. |

`<XDG_DATA_DIR>` resolves via `dirs::data_dir()`:

- macOS: `~/Library/Application Support/clepsydra/state.db`
- Linux: `~/.local/share/clepsydra/state.db`
- Windows: `%APPDATA%\clepsydra\state.db`

The directory is created on first open. If `dirs::data_dir()` returns `None` (rare; CI containers without `$HOME`), `state.db` features are disabled with a startup warning.

### Why split

Every existing table in `cache.db` is rebuildable from the filesystem; the codebase relies on that invariant (`doctor`, integration tests, the `IndexHandle` rebuild path). Mixing authoritative state into `cache.db` would silently break that property. Splitting preserves it: `cache.db` stays "delete me, no problem"; `state.db` is "the real persisted state, treat carefully."

### Why XDG-shared rather than vault-local

The user expects to open multiple vaults from the same machine over time. A machine-shared `state.db` keyed by vault UUID handles this cleanly: each vault carries its identity in its own config, the registry tracks where it currently lives, and runtime state survives `rm -rf .clepsydra/`. The cost — a stable vault identifier — is paid by storing a UUID in vault config.

---

## 3) Vault identity

### Generation and persistence

- A new `id` field is added to `<vault>/.clepsydra/config.toml`: `id = "<uuid-v7>"`.
- On `Vault::open`: read config; if `id` is absent, generate a UUID v7, write it back atomically (tempfile + rename), and re-read the resulting config. The UUID is then immutable for the life of the vault.
- The `uuid` crate (already a dependency, with `v7` feature) provides generation.

### Atomic write strategy (open question, decide in implementation)

The vault config is small and rewritten in place. Two strategies are acceptable:

- `tempfile + rename` in the same directory. Atomic on POSIX; on Windows the rename can fail if the target is open, but vault config is only ever opened by `clepsydra` itself.
- Plain in-place write under `.clepsydra/`. Simpler; tolerable for personal software where a torn write would be detected on next read (TOML parse failure → soft fail per existing convention).

Lean toward `tempfile + rename` for safety. Confirm during implementation review.

### Failure modes

- Vault config write fails during UUID upgrade: server refuses to start with a clear error, since no state row can be created without the vault id.
- UUID is malformed in config: server refuses to start with a clear error. Manual recovery is "remove the malformed line and let the server regenerate."

### Identity is intrinsic; path is a hint

`vaults.current_path` in the registry is updated on every `Vault::open` to track moves, but lookups are always by `id`. Moving a vault folder thus preserves its state.

---

## 4) Schema

### Migration v1: initial schema

```sql
CREATE TABLE vaults (
  id              TEXT PRIMARY KEY,           -- UUID v7
  current_path    TEXT NOT NULL,              -- absolute path; updated on open
  display_name    TEXT,                       -- optional human label (registry-local)
  last_opened_at  INTEGER NOT NULL,           -- unix epoch seconds
  created_at      INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE vault_meta (
  vault_id     TEXT    NOT NULL
                       REFERENCES vaults(id) ON DELETE CASCADE,
  key          TEXT    NOT NULL,
  value        TEXT    NOT NULL CHECK (json_valid(value)),
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (vault_id, key)
) WITHOUT ROWID;
```

- `WITHOUT ROWID` for both — both have compound or natural string primary keys.
- `CHECK (json_valid(value))` enforces well-formed JSON at write time. SQLite ≥ 3.38 (the bundled rusqlite version satisfies this).
- The PK on `(vault_id, key)` is a covering index for vault-prefix scans; no additional indexes needed.
- `ON DELETE CASCADE` so dropping a vault from the registry sweeps its meta.

### `display_name` placement (open question)

`vaults.display_name` lives in the registry — it's a machine-local human label, not a vault-portable property. If we ever want a "this vault is called X" that travels with the vault, that's a separate field in vault config TOML. Worth a sentence in the implementation PR; not blocking.

### Migration runner

```rust
// src/state/migrations.rs
const MIGRATIONS: &[&str] = &[
    /* v1 */ include_str!("migrations/0001_initial.sql"),
];

pub fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
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
```

Migrations are forward-only and embedded via `include_str!`. Running `migrate` against a freshly-migrated database is a no-op (the `skip` handles it).

---

## 5) Rust API

### Module layout

```
src/state/
  mod.rs              -- StateDb struct, public API, error types
  migrations.rs       -- migration runner
  migrations/
    0001_initial.sql  -- schema
  meta.rs             -- MetaKey enum + typed get/set/snapshot
  registry.rs         -- vaults table operations
```

### Public surface

```rust
pub struct VaultId(pub uuid::Uuid);

pub struct StateDb {
    conn: parking_lot::Mutex<rusqlite::Connection>,
}

impl StateDb {
    /// Open `state.db` at the given path, run migrations, return the handle.
    pub fn open(path: &Path) -> Result<Self>;

    /// Insert or update the vault's row; bumps `last_opened_at` and refreshes
    /// `current_path`. Idempotent.
    pub fn register_vault(&self, id: VaultId, path: &Path) -> Result<()>;

    /// Bump `last_opened_at` only.
    pub fn touch_last_opened(&self, id: VaultId) -> Result<()>;

    pub fn get<T: DeserializeOwned>(&self, id: VaultId, key: MetaKey) -> Result<Option<T>>;
    pub fn set<T: Serialize>(&self, id: VaultId, key: MetaKey, value: &T) -> Result<()>;
    pub fn clear(&self, id: VaultId, key: MetaKey) -> Result<()>;

    /// Read all known keys in one transaction; absent keys map to None.
    pub fn snapshot(&self, id: VaultId) -> Result<MetaSnapshot>;
}

pub enum MetaKey {
    LastOpenedTab,
    // grows as consumers land
}
impl MetaKey {
    fn as_str(&self) -> &'static str { /* one place */ }
}

pub struct MetaSnapshot {
    pub last_opened_tab: Option<String>,
    // one Option<TypedValue> per known MetaKey variant
}
```

### Concurrency

`Mutex<Connection>` is sufficient for v1: clepsydra is single-process, meta writes are infrequent and small, and SQLite's WAL handles read concurrency well. If contention shows up, revisit (connection pool, or a dedicated state thread mirroring `IndexHandle`).

### `AppState` integration

```rust
pub state: Option<Arc<crate::state::StateDb>>,
pub vault_id: VaultId,   // resolved at startup, after the UUID upgrade
```

`Option<StateDb>` because state.db may fail to open (permissions, disk full, no `dirs::data_dir()`); features that depend on it return `503` rather than crashing the server.

---

## 6) HTTP API

### Endpoints (mounted under `/api/vault/meta`)

| Method | Path | Body | Response | Notes |
|--------|------|------|----------|-------|
| GET | `/api/vault/meta` | — | `MetaSnapshot` (200) | Hydrates all known keys for the bound vault. |
| PUT | `/api/vault/meta/:key` | JSON value | 204 | Type-validated against the variant's declared type. |
| DELETE | `/api/vault/meta/:key` | — | 204 | Idempotent; deleting a missing key returns 204. |

- Endpoints scope to the current vault. `AppState.vault_id` provides the id; no `vault_id` parameter on the URL.
- `:key` parses to `MetaKey`. Unknown keys return `400 Bad Request` with `{ "error": "unknown_key" }`.
- PUT body type mismatch returns `400 Bad Request` with `{ "error": "type_mismatch" }`.
- If `state.db` failed to open, all three endpoints return `503 Service Unavailable` with `{ "error": "state_unavailable" }`.

### OpenAPI

`MetaSnapshot` is a Rust struct with one `Option<T>` field per `MetaKey` variant. utoipa generates the typed JSON schema; `bun run openapi` regenerates the TypeScript schema.

The PUT body type is `serde_json::Value` at the wire layer (utoipa cannot express "the body shape depends on the path param"). The server-side handler enforces the per-variant type. The endpoint description documents this.

### `:key` schema

Declared as a plain string in OpenAPI (utoipa's enum-in-path support is awkward). The closed set is enforced by the server-side parse, with the description listing valid values.

---

## 7) Frontend integration

### Hooks (`ui/src/api/meta.ts`)

```ts
export interface MetaSnapshot {
  last_opened_tab?: string;
  // grows as MetaKey grows
}

export function useMeta() {
  return useQuery<MetaSnapshot>({
    queryKey: queryKeys.meta.snapshot,
    queryFn: async () => {
      const res = await fetch("/api/vault/meta");
      if (!res.ok) throw new Error("Failed to fetch meta");
      return res.json();
    },
    staleTime: Infinity, // hydrate once; mutations update the cache directly
  });
}

export function useSetMeta() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async <K extends keyof MetaSnapshot>(args: {
      key: K;
      value: MetaSnapshot[K];
    }) => {
      const res = await fetch(`/api/vault/meta/${args.key}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args.value),
      });
      if (!res.ok) throw new Error("Failed to set meta");
    },
    onSuccess: (_, { key, value }) => {
      qc.setQueryData<MetaSnapshot>(queryKeys.meta.snapshot, (prev) => ({
        ...(prev ?? {}),
        [key]: value,
      }));
    },
  });
}

export function useClearMeta() { /* DELETE + cache update, mirrors useSetMeta */ }
```

`queryKeys.meta = { snapshot: ["meta"] as const }` is added to `ui/src/api/keys.ts`.

### Refresh strategy

`staleTime: Infinity` — the snapshot only changes via this client's own mutations, so background refetch isn't needed. If we ever add server-side meta writes from another client, we add an SSE event and invalidate.

### localStorage boundary (rule of thumb)

Captured as a comment in `ui/src/api/meta.ts`:

> If the state describes *the vault* (recent searches inside this vault, pinned folios, last-opened tab) → `state.db` via `useMeta()`.
> If it describes *how the user prefers the app to behave* (theme, font scale, dismissed onboarding banners) → `localStorage`.
>
> Test: if you opened the same vault from a different browser on the same machine, would you expect this state to follow you? Yes → `state.db`. No → `localStorage`.

This spec does not migrate any existing `localStorage` callsites; it only writes the rule down.

---

## 8) First consumer: `LastOpenedTab`

To prove the full path end-to-end on day one:

- Add `MetaKey::LastOpenedTab` with value type `String` (a tab id or path).
- On tab activation in the existing tab system (`useOpenTab` and friends), call `useSetMeta` with key `last_opened_tab` (debounced ~500 ms).
- On app load, hydrate the active tab from `useMeta().data?.last_opened_tab` if present; fall back to the existing default.

This consumer is small (single string), exercises read/write/snapshot/cache update, fails gracefully (no value → existing default), and has a visible payoff (resume where you left off).

---

## 9) Testing

### Unit

- Migration runner: applies v1 against `:memory:`; running twice is idempotent.
- `MetaKey::as_str` round-trip for every variant.
- JSON validation: setting a value via raw SQL with `value = 'not json'` fails the `CHECK` constraint.
- `set<T>` + `get<T>` round-trip for `String`, `Vec<String>`, struct types.
- `get<U>` for `U` ≠ originally-stored `T` returns `Err` (or `None`, depending on chosen semantics — decide in implementation; document either way).

### Integration

- `tests/state_meta_test.rs` mirroring the existing `api_*_test.rs` pattern, against an in-memory `StateDb` injected into `AppState`.
- Covers: register vault → set → get → snapshot → clear → ON DELETE CASCADE behavior on `DELETE FROM vaults WHERE id = ?`.
- HTTP layer: `axum-test::TestServer` exercises GET/PUT/DELETE with success and error cases (unknown key, type mismatch, 503 on absent state.db).

### Frontend

- Vitest covers `useMeta` + `useSetMeta` cache update on mutation success.
- Manual smoke: open a tab, refresh the browser, verify the tab is restored.

---

## 10) Build sequence (implementation hint)

1. `src/state/` module: schema, migration runner, `StateDb`, in-process tests. No `AppState` changes.
2. Vault config UUID upgrade in `Vault::open` (atomic write strategy chosen here).
3. `AppState.state` and `AppState.vault_id` wiring; open `state.db` in `lib.rs::run_server`; call `register_vault` + `touch_last_opened`.
4. `MetaKey::LastOpenedTab` variant + `MetaSnapshot` struct.
5. HTTP endpoints (`src/api/meta.rs`) + OpenAPI registration + `bun run openapi` regen.
6. Frontend `useMeta` / `useSetMeta` / `useClearMeta` hooks.
7. Wire `LastOpenedTab` into the tab activation path; hydrate on app load.
8. End-to-end smoke: open a tab, kill the server, restart, verify restoration.

Steps 1–2 are pure backend, no observable behavior change. Steps 3–5 expose the API. Steps 6–7 are the user-visible feature.

---

## 11) Open questions (resolve in implementation)

- **Atomic vault config write**: `tempfile + rename` (recommended) vs. plain in-place write. Confirm in PR.
- **`get<U>` with mismatched type**: return `Err` (strict) or `Ok(None)` (lenient)? Recommendation: `Err` — silent type mismatches are how stringly-typed bugs creep back in.
- **`display_name` location**: `vaults.display_name` (registry, machine-local) is the spec's choice. If a vault-portable display name becomes desired, it's a separate TOML field.
- **`state.db` location override**: should there be an env var (e.g. `CLEPSYDRA__STATE__PATH`) for tests and ops? Lean yes; trivial to add.
