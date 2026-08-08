# Encrypted Notes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. For the React tasks, also load `vercel-react-best-practices`. Use checkbox (`- [ ]`) syntax for progress and run the stated verification after every task.

**Goal:** Add opt-in encrypted note bodies that remain UTF-8 Markdown files with clear TOML metadata and an ASCII-armored age payload, with decryption and encryption performed only in the frontend.

**Architecture:** A protected page keeps its normal `+++` TOML frontmatter and stores exactly one age-armored ciphertext as its body. The Rust backend treats that body as opaque, rejects accidental plaintext writes, and indexes only clear metadata; the React frontend unwraps a vault age identity with a password or imports an identity, keeps it only in memory, decrypts immediately before editing, and encrypts before every body write. A small vault keyring under `.clepsydra/crypto/` contains the public recipient and, optionally, a password-wrapped private identity; neither passwords, private identities, nor plaintext protected bodies cross the HTTP boundary.

**Tech Stack:** Rust 2024, Axum 0.8, rusqlite/FTS5, serde + toml, existing `base64` and BLAKE3 crates, atomic-file helpers, utoipa/OpenAPI. Frontend: React 19, TanStack Query, Slate, react-aria-components, Vitest, dynamically imported [`age-encryption`](https://github.com/FiloSottile/typage).

**Reference implementation areas:** `src/vault/page.rs`, `src/vault/index.rs`, `src/vault/mutation_coordinator.rs`, `src/api/pages.rs`, `src/api/index_routes.rs`, `ui/src/editor/usePageEditor.ts`, `ui/src/components/codex/Folio.tsx`, `ui/src/components/codex/PreviewBody.tsx`.

---

## Product and security decisions

These decisions are part of the implementation contract. Do not silently broaden or weaken them while implementing.

1. **Body-only encryption.** Path, title, type, project, tags, aliases, timestamps, and other frontmatter remain clear. Attachments remain clear and the UI must say so.
2. **One vault identity in v1.** Notes identify the vault key with `key_id`. Per-note passwords, sharing, multiple recipients, and key rotation are follow-ups; the file format leaves room for them.
3. **Password wraps the identity, not each note.** The frontend performs the expensive passphrase operation once per unlock. Autosaves encrypt to the public recipient and do not rerun a password KDF.
4. **Imported-key mode is supported.** A user may store only the public recipient in the vault and import the matching age identity each session.
5. **The backend never decrypts.** It receives and returns armored ciphertext. It cannot provide body search, outbound links, blocks, word counts, task extraction, or LSP body intelligence for protected pages.
6. **Encrypted state is first-class.** Do not infer security state from body text alone. The TOML `encryption` field is authoritative; armor validation is a second guard.
7. **Fail closed.** A protected page's normal update path rejects any supplied body that is not canonical age armor. Protection and unprotection use dedicated atomic transitions.
8. **Persistent frontend caches hold ciphertext only.** Decrypted Markdown, passwords, and identities must never enter TanStack Query, Zustand persistence, localStorage, sessionStorage, IndexedDB, URLs, analytics, or logs.
9. **JavaScript erasure is best-effort.** Locking drops all references and remounts editors, but documentation must not claim reliable zeroization of JavaScript strings.
10. **Old copies are outside the guarantee.** Protecting a note cannot erase Git history, external backups, filesystem snapshots, SSD remnants, clipboard history, or a compromised client. The app scrubs its disposable SQLite cache and warns about the rest.

### Canonical page format

```markdown
+++
id = "019fd000-0000-7000-8000-000000000001"
title = "Private note"
encryption = { format = "age", version = 1, key_id = "019fd000-0000-7000-8000-000000000002" }
+++
-----BEGIN AGE ENCRYPTED FILE-----
YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSAuLi4K
-----END AGE ENCRYPTED FILE-----
```

The body contains no Markdown wrapper or commentary around the armor. One trailing newline is canonical. This keeps extraction and CLI interoperability simple.

### Expected feature behavior

| Surface | Plain page | Protected page |
|---|---|---|
| File tree/title/tags | Normal | Normal; lock badge shown |
| Page API body | Markdown | Age armor |
| React editor | Markdown | Decrypted in memory after unlock |
| Server FTS | Full body + title | Title only |
| Outbound links/blocks/word count | Derived | Empty/unknown |
| Inbound links from plain pages | Normal | Still resolve to clear title/id |
| Hover preview | Markdown | Locked placeholder in v1 |
| LSP | Full behavior | Locked diagnostic; no body semantics |

---

## File structure

### Backend

- `src/vault/encryption.rs` — **create.** Encryption metadata, canonical age-armor validation, and helpers.
- `src/vault/keyring.rs` — **create.** Public-recipient and wrapped-identity persistence under `.clepsydra/crypto/`.
- `src/vault/page.rs` — **modify.** First-class `EncryptionMeta` in `PageMeta`, TOML parse/write, `Page::is_encrypted()`.
- `src/vault/derivation.rs` — **modify.** Carry `encrypted` on `IndexedPage`.
- `src/vault/index.rs` — **modify.** `pages.encrypted`, migration, body-derivation suppression, secure deletion/scrub operation.
- `src/vault/index_handle.rs` — **modify.** Serialize cache scrubbing on the index thread.
- `src/vault/mod.rs` — **modify.** Export encryption/keyring modules.
- `src/vault/base.rs`, `src/api/properties.rs` — **modify.** Reserve the `encryption` system field.
- `src/api/encryption.rs` — **create.** Keyring setup/read/rewrap endpoints; no secret plaintext inputs.
- `src/api/pages.rs` — **modify.** DTOs, `encrypted`/`encryption` responses, protect/unprotect endpoints, normal-update guard.
- `src/api/index_routes.rs`, `src/api/blocks.rs`, `src/api/{journal,tasks,agenda}.rs` — **modify as audit requires.** No body-derived data from protected pages.
- `src/api/{mod,openapi,frontend}.rs` — **modify.** Route/schema registration and security headers.
- `src/lsp/{document,diagnostics,hover,symbols,mod}.rs` — **modify.** Detect protected documents and suppress body semantics.
- `tests/encryption_test.rs`, `tests/api_encryption_test.rs` — **create.** Domain, index, API, cache, and concurrency coverage.

### Frontend

- `ui/package.json`, `ui/bun.lock` — **modify.** Add and lock `age-encryption`.
- `ui/src/api/encryption.ts`, generated `ui/src/api/schema.d.ts` — **create/modify.** Typed keyring and protection calls.
- `ui/src/crypto/age.ts` — **create.** Dynamically imported age wrapper; the only module that talks to the dependency.
- `ui/src/crypto/session.ts` — **create.** In-memory identity/session abstraction without React.
- `ui/src/crypto/EncryptionProvider.tsx` — **create.** Split status/actions contexts, lock coordination, idle policy.
- `ui/src/crypto/__tests__/age.test.ts`, `EncryptionProvider.test.tsx` — **create.** Interop, tamper, persistence, and lifecycle tests.
- `ui/src/main.tsx` — **modify.** Install the provider inside QueryClientProvider.
- `ui/src/editor/usePageEditor.ts` — **modify.** Async decrypt/load, encrypted saves, conflict reload, promise-returning flush.
- `ui/src/editor/__tests__/usePageEditor.encryption.test.tsx` — **create.** Editor/network/cache invariants.
- `ui/src/components/codex/EncryptionSetupDialog.tsx` — **create.** Generate or import identity, recovery acknowledgement.
- `ui/src/components/codex/NoteProtectionDialog.tsx` — **create.** Protect/unprotect confirmation and warnings.
- `ui/src/components/codex/LockedFolio.tsx` — **create.** Unlock/error state.
- `ui/src/components/codex/{Folio,PreviewBody,LinkPreviewLayer}.tsx`, `ui/src/editor/PageEditorHeader.tsx` — **modify.** Controls, badges, and locked previews.

### Documentation

- `docs/encrypted-notes.md`, `docs/configuration.md` — **create/modify.** Threat model, setup, recovery, limitations.

---

## Phase 1 — File format and domain model

### Task 1: Add encryption metadata and canonical armor validation

**Files:**
- Create: `src/vault/encryption.rs`
- Modify: `src/vault/mod.rs`
- Create: `tests/encryption_test.rs`

- [ ] **Step 1: Write failing armor tests.** Cover canonical armor, missing/extra fences, prefix/suffix text, empty payload, invalid Base64, decoded data not beginning `age-encryption.org/v1\n`, CRLF normalization policy, and the maximum accepted armored-body size. The validator must never print body content in an error.

```rust
use clepsydra::vault::encryption::{validate_age_armor, EncryptionFormat, EncryptionMeta};

#[test]
fn accepts_one_canonical_age_block() {
    let armor = include_str!("support/fixtures/private-note.age");
    validate_age_armor(armor).expect("valid age armor");
}

#[test]
fn rejects_plaintext_without_echoing_it() {
    let secret = "do-not-repeat-this-secret";
    let error = validate_age_armor(secret).unwrap_err().to_string();
    assert!(!error.contains(secret));
}

#[test]
fn encryption_meta_supports_only_age_v1() {
    let meta = EncryptionMeta {
        format: EncryptionFormat::Age,
        version: 1,
        key_id: "019fd000-0000-7000-8000-000000000002".into(),
    };
    meta.validate().unwrap();
}
```

- [ ] **Step 2: Run the focused test.**

Run: `cargo test --test encryption_test -- --nocapture`

Expected: FAIL because `vault::encryption` does not exist.

- [ ] **Step 3: Implement the public domain types and syntactic validator.** Use the existing `base64` dependency; do not add a Rust encryption implementation. Keep the API small:

```rust
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EncryptionFormat {
    Age,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct EncryptionMeta {
    pub format: EncryptionFormat,
    pub version: u8,
    pub key_id: String,
}

impl EncryptionMeta {
    pub fn validate(&self) -> Result<(), EncryptionError>;
}

pub fn validate_age_armor(body: &str) -> Result<(), EncryptionError>;
pub fn canonicalize_age_armor(body: &str) -> Result<String, EncryptionError>;
```

Validation is structural, not cryptographic. Authentication is performed by age during frontend decryption.

- [ ] **Step 4: Register the module and rerun the tests.**

Run: `cargo test --test encryption_test -- --nocapture`

Expected: all armor/domain tests PASS.

- [ ] **Step 5: Run formatting and lint for the touched Rust surface.**

Run: `cargo fmt --check && cargo clippy --all-targets --all-features -- -D warnings`

Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/vault/encryption.rs src/vault/mod.rs tests/encryption_test.rs tests/support/fixtures/private-note.age
git commit -m "feat(vault): define encrypted note envelope"
```

### Task 2: Round-trip encryption metadata through page parsing

**Files:**
- Modify: `src/vault/page.rs`
- Modify: `src/vault/base.rs`
- Modify: `src/api/properties.rs`
- Modify: `tests/frontmatter_test.rs`
- Modify: `tests/property_patch.rs`

- [ ] **Step 1: Add failing frontmatter tests.** Assert that the canonical example parses into `PageMeta.encryption`, preserves the armored body exactly, serializes back to TOML, rejects unsupported versions and empty key IDs, and does not place `encryption` into `PageMeta.extra`.

- [ ] **Step 2: Add a failing properties test.** A generic property PATCH attempting to set or clear `encryption` must return 400 as a reserved system field.

- [ ] **Step 3: Run the focused tests.**

Run: `cargo test --test frontmatter_test encryption -- --nocapture && cargo test --test property_patch encryption -- --nocapture`

Expected: FAIL because encryption is currently treated as an untyped extra.

- [ ] **Step 4: Add the first-class field.** Extend `PageMeta`, custom serialization, `meta_from_table`, `write_page_content`, and `Page`:

```rust
pub struct PageMeta {
    // existing fields
    pub encryption: Option<EncryptionMeta>,
    pub extra: ExtraMap,
}

impl Page {
    pub fn is_encrypted(&self) -> bool {
        self.meta.encryption.is_some()
    }
}
```

Parse the TOML representation as a table or inline table, but always write one canonical representation. Validate the armor only when `encryption.is_some()`; an unmarked age-looking body remains an ordinary text body.

- [ ] **Step 5: Reserve the field everywhere system fields are enumerated.** Update `src/vault/base.rs` and `src/api/properties.rs`; search for duplicated reserved-field lists with `rg -n 'updated_at|RESERVED' src` and update each relevant list.

- [ ] **Step 6: Run the page/property regression tests.**

Run: `cargo test --test frontmatter_test -- --nocapture && cargo test --test property_patch -- --nocapture && cargo test page:: --lib`

Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/vault/page.rs src/vault/base.rs src/api/properties.rs tests/frontmatter_test.rs tests/property_patch.rs
git commit -m "feat(vault): persist encryption metadata"
```

---

## Phase 2 — Ciphertext-safe indexing

### Task 3: Add encrypted state to the index and suppress body derivation

**Files:**
- Modify: `src/vault/derivation.rs`
- Modify: `src/vault/index.rs`
- Modify: `src/vault/tree.rs`
- Modify: `tests/index_test.rs`
- Modify: `tests/block_index_test.rs`
- Modify: `tests/link_extraction_test.rs`

- [ ] **Step 1: Write a failing forward-migration test.** Open an index using the existing old-pages fixture, verify `VaultIndex::open` adds `pages.encrypted INTEGER NOT NULL DEFAULT 0`, then reopen it to prove idempotence.

- [ ] **Step 2: Write failing protected-page derivation tests.** Seed a protected note whose known plaintext previously contained a unique search term, a wikilink, a block ID, a heading, and several words. After indexing, assert:

```rust
assert_eq!(page_column::<i64>(&index, "encrypted"), 1);
assert_eq!(page_column::<Option<i64>>(&index, "word_count"), None);
assert_eq!(count_rows(&index, "links"), 0);
assert_eq!(count_rows(&index, "blocks"), 0);
assert!(index.search("unique-secret-term", 20).unwrap().is_empty());
assert_eq!(index.search("Private note", 20).unwrap().len(), 1); // title remains searchable
```

Also prove that a plain page linking *to* the protected page still resolves, because the target's ID/title are clear.

- [ ] **Step 3: Write a failing transition test.** Index a plaintext note, confirm derived rows exist, rewrite it as protected, reindex, and confirm every prior body-derived row is deleted.

- [ ] **Step 4: Run focused tests.**

Run: `cargo test --test index_test encrypted -- --nocapture && cargo test --test block_index_test encrypted -- --nocapture && cargo test --test link_extraction_test encrypted -- --nocapture`

Expected: FAIL because ciphertext is currently parsed and inserted into FTS.

- [ ] **Step 5: Add schema and migration support.** Extend `SCHEMA`, rename `migrate_pages_add_kind_columns` to describe all page projection columns, and add an idempotent encrypted-column branch before the schema batch.

- [ ] **Step 6: Suppress body derivation at the parse boundary.** `IndexedPage` should carry `encrypted: bool`. For protected pages, retain the raw armored body only in `Page`; feed an empty body, no body links, and no blocks into the derivation/index path. Preserve clear tags, canonical names, property links, kind, project, and timestamps. Bind `NULL` for `word_count` and insert an empty FTS body with the clear title.

- [ ] **Step 7: Update read models.** Add encrypted state to tree metadata and ensure tree displays do not turn `NULL` word counts into zero.

- [ ] **Step 8: Run index regressions.**

Run: `cargo test --test index_test -- --nocapture && cargo test --test block_index_test -- --nocapture && cargo test --test link_extraction_test -- --nocapture && cargo test --test block_parser_test -- --nocapture`

Expected: PASS.

- [ ] **Step 9: Commit.**

```bash
git add src/vault/derivation.rs src/vault/index.rs src/vault/tree.rs tests/index_test.rs tests/block_index_test.rs tests/link_extraction_test.rs
git commit -m "feat(index): keep encrypted bodies out of derived data"
```

### Task 4: Securely scrub prior cache projections

**Files:**
- Modify: `src/vault/index.rs`
- Modify: `src/vault/index_handle.rs`
- Modify: `tests/index_handle_test.rs`
- Modify: `tests/encryption_test.rs`

- [ ] **Step 1: Write a failing cache-remnant test.** Put a unique plaintext marker into FTS and blocks, protect/reindex the page, call the planned scrub method, drop the index, and scan `cache.db`, `cache.db-wal`, and `cache.db-shm` if present. The marker must not occur as bytes.

- [ ] **Step 2: Run it and record the expected failure.**

Run: `cargo test --test encryption_test scrub_removes_plaintext_from_cache_files -- --nocapture`

Expected: FAIL because deleted SQLite/WAL content can remain on disk.

- [ ] **Step 3: Enable secure deletion.** Add `PRAGMA secure_delete=ON` during index connection setup before schema mutation.

- [ ] **Step 4: Add a serialized scrub operation.** Implement `VaultIndex::scrub_deleted_content()` and expose it through `IndexHandle`, running on the index thread after the protection reindex:

```rust
pub fn scrub_deleted_content(&mut self) -> Result<(), IndexError> {
    self.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")?;
    Ok(())
}
```

If SQLite requires checkpoint and vacuum as separate calls, keep them outside a transaction. Treat a scrub failure after a successful file write as a visible partial-success error; never roll the note back to plaintext.

- [ ] **Step 5: Rerun the byte-scan and index-handle tests.**

Run: `cargo test --test encryption_test scrub -- --nocapture && cargo test --test index_handle_test -- --nocapture`

Expected: PASS on all supported platforms. If a platform persistently retains the marker, document the limitation and rebuild the disposable DB through a close/recreate index-thread operation instead of weakening the test.

- [ ] **Step 6: Commit.**

```bash
git add src/vault/index.rs src/vault/index_handle.rs tests/index_handle_test.rs tests/encryption_test.rs
git commit -m "feat(index): scrub plaintext projections after protection"
```

---

## Phase 3 — Atomic protection API

### Task 5: Expose encryption state and add protect/unprotect transitions

**Files:**
- Modify: `src/api/pages.rs`
- Modify: `src/api/folders.rs`
- Modify: `src/api/openapi.rs`
- Modify: `tests/api_encryption_test.rs`
- Modify: `tests/api_test.rs`

- [ ] **Step 1: Write failing response-contract tests.** `PageDetail` and every `PageSummary` source must return `encrypted: bool`; detail also returns the typed `encryption` descriptor or `null`. Update folder fallbacks so their row order cannot drift from `page_summary_from_row`.

- [ ] **Step 2: Write failing protect tests.** Cover: correct expected revision; UUID lookup; atomic marker+ciphertext write; 409 on stale revision; 400 on invalid armor; 404 on unknown UUID; clear metadata preserved; index rows cleared; returned revision hashes the exact encrypted file.

- [ ] **Step 3: Write failing unprotect tests.** Cover: authenticated frontend supplies plaintext; the endpoint atomically clears `encryption` and replaces the body; stale revision and unknown UUID fail; the resulting plain body is indexed normally.

- [ ] **Step 4: Write the central fail-closed regression.** Once a page is marked protected, `PUT /pages/{path}` and `PUT /pages/by-id/{uuid}` with `body: "plaintext"` must return 400 and leave the file byte-identical. A metadata-only update must still succeed and preserve ciphertext byte-for-byte.

- [ ] **Step 5: Run the focused API tests.**

Run: `cargo test --test api_encryption_test -- --nocapture`

Expected: FAIL because the DTO fields and routes do not exist.

- [ ] **Step 6: Add explicit API schemas.** Do not rely on `PageMeta.extra`, because `PageMetaResponse` intentionally exposes only typed fields. Add:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct EncryptionMetaResponse {
    pub format: String,
    pub version: u8,
    pub key_id: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ProtectPageRequest {
    pub expected_revision: String,
    pub encryption: EncryptionMetaResponse,
    pub body: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UnprotectPageRequest {
    pub expected_revision: String,
    pub body: String,
}
```

Add `encrypted` and `encryption` to the detail response and `encrypted` to summaries.

- [ ] **Step 7: Add non-wildcard routes by UUID.** Register `POST /api/vault/pages/by-id/{uuid}/protect` and `POST /api/vault/pages/by-id/{uuid}/unprotect` before the generic UUID update route. Both adapt to the existing `UpdatePageCommand`, so expected-content locking, atomic publication, notifications, and reindexing remain centralized.

- [ ] **Step 8: Add the normal-update guard.** After loading the current page but before constructing `UpdatePageCommand`, validate any new body against current protection state. The regular update API cannot change `PageMeta.encryption`.

- [ ] **Step 9: Trigger cache scrub after successful protection reindex.** Await the index-handle scrub before returning success. If it fails, return a precise error saying the note is protected but the cache scrub failed; never include content.

- [ ] **Step 10: Run page/folder/API regressions.**

Run: `cargo test --test api_encryption_test -- --nocapture && cargo test --test api_test -- --nocapture && cargo test --test bases_api -- --nocapture`

Expected: PASS.

- [ ] **Step 11: Commit.**

```bash
git add src/api/pages.rs src/api/folders.rs src/api/openapi.rs tests/api_encryption_test.rs tests/api_test.rs
git commit -m "feat(api): add atomic note protection transitions"
```

---

## Phase 4 — Vault keyring

### Task 6: Persist public recipients and wrapped identities

**Files:**
- Create: `src/vault/keyring.rs`
- Modify: `src/vault/mod.rs`
- Create: `tests/keyring_test.rs`

- [ ] **Step 1: Write failing persistence tests.** Cover no-keyring, first setup, duplicate setup conflict, read round-trip, invalid key ID/recipient/control characters, invalid wrapped identity armor, optimistic rewrap conflict, atomic replacement, file permissions where supported, and errors that never echo armor.

- [ ] **Step 2: Define the minimal v1 model.**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultKeyring {
    pub version: u8,
    pub active_key_id: String,
    pub keys: Vec<VaultKeyRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultKeyRecord {
    pub id: String,
    pub recipient: String,
    pub wrapped_identity_file: Option<String>,
}

pub struct KeyringSnapshot {
    pub keyring: VaultKeyring,
    pub wrapped_identity: Option<String>,
    pub revision: String,
}
```

Store metadata at `.clepsydra/crypto/keyring.toml` and armor at `.clepsydra/crypto/<key-id>.identity.age`. Paths are constructed internally; request data never becomes a path.

- [ ] **Step 3: Implement atomic writes.** Use `atomic_create` for first setup and `atomic_replace` for rewrap. Set owner-only permissions on Unix after creation and test them conditionally. The public recipient may be returned freely; the identity file is always wrapped armor or absent.

- [ ] **Step 4: Run keyring tests.**

Run: `cargo test --test keyring_test -- --nocapture`

Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/vault/keyring.rs src/vault/mod.rs tests/keyring_test.rs
git commit -m "feat(vault): persist encrypted note keyring"
```

### Task 7: Add keyring API without accepting unlock secrets

**Files:**
- Create: `src/api/encryption.rs`
- Modify: `src/api/mod.rs`
- Modify: `src/api/openapi.rs`
- Modify: `tests/api_encryption_test.rs`

- [ ] **Step 1: Write failing endpoint tests.** Specify these routes:

  - `GET /api/vault/encryption` — initialization state, public recipient, key ID, optional wrapped identity armor, revision.
  - `POST /api/vault/encryption/setup` — one-time keyring creation; 409 if already initialized.
  - `PUT /api/vault/encryption/wrapped-identity` — replace only the active wrapped identity with `expected_revision`; supports password change.

No request has fields named `password`, `passphrase`, `identity`, `private_key`, or `plaintext`. The setup field is explicitly `wrapped_identity`.

- [ ] **Step 2: Run the tests.**

Run: `cargo test --test api_encryption_test keyring -- --nocapture`

Expected: FAIL because the routes are absent.

- [ ] **Step 3: Implement DTOs and handlers.** Keep all path/file logic in `vault::keyring`; handlers validate DTOs, map conflicts, and return typed OpenAPI schemas. Cap recipient and wrapped-identity sizes before allocation/decoding.

- [ ] **Step 4: Register routes and schemas.** Nest under `/api/vault/encryption`; update the OpenAPI components list.

- [ ] **Step 5: Run API regressions.**

Run: `cargo test --test api_encryption_test -- --nocapture && cargo test --test api_test -- --nocapture`

Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/api/encryption.rs src/api/mod.rs src/api/openapi.rs tests/api_encryption_test.rs
git commit -m "feat(api): expose encrypted keyring metadata"
```

---

## Phase 5 — Browser crypto and session lifecycle

### Task 8: Generate the API types and add the isolated age adapter

**Files:**
- Modify: `ui/package.json`
- Modify: `ui/bun.lock`
- Modify: `ui/src/api/schema.d.ts` (generated)
- Create: `ui/src/api/encryption.ts`
- Create: `ui/src/crypto/age.ts`
- Create: `ui/src/crypto/__tests__/age.test.ts`
- Add: `ui/src/crypto/__tests__/fixtures/` interoperability fixtures

- [ ] **Step 1: Regenerate OpenAPI types.** Start the server from the implementation worktree, then run:

Run: `cd ui && bun run openapi`

Expected: generated schemas include encryption state, protect/unprotect, and keyring routes. Do not hand-edit `schema.d.ts`.

- [ ] **Step 2: Add the pinned dependency.**

Run: `cd ui && bun add age-encryption`

Expected: `package.json` and `bun.lock` change; no unrelated packages are upgraded.

- [ ] **Step 3: Write failing adapter tests.** Cover generated identity→recipient, identity wrapping/unwrapping, note encrypt/decrypt, wrong password, wrong identity, tamper, Unicode, empty Markdown, and fixtures mutually produced by the reference age CLI and TypeScript package.

- [ ] **Step 4: Implement one lazy-loaded adapter.** No React component imports `age-encryption` directly.

```ts
let ageModule: Promise<typeof import("age-encryption")> | null = null;

function loadAge() {
  ageModule ??= import("age-encryption");
  return ageModule;
}

export async function createVaultIdentity(): Promise<{
  identity: string;
  recipient: string;
}>;
export async function wrapIdentity(identity: string, password: string): Promise<string>;
export async function unwrapIdentity(armor: string, password: string): Promise<string>;
export async function encryptMarkdown(markdown: string, recipient: string): Promise<string>;
export async function decryptMarkdown(armor: string, identity: string): Promise<string>;
```

Canonicalize armor to the backend format. Never include source material in thrown error messages.

- [ ] **Step 5: Add typed API hooks.** `useEncryptionConfig`, `useSetupEncryption`, `useRewrapIdentity`, `useProtectPage`, and `useUnprotectPage` should invalidate the same page/query keys used by existing mutations.

- [ ] **Step 6: Run focused frontend tests and bundle inspection.**

Run: `cd ui && bun run test src/crypto/__tests__/age.test.ts && bun run build`

Expected: tests PASS and the production output contains a separate lazy age chunk rather than adding it to initial application code.

- [ ] **Step 7: Commit.**

```bash
git add ui/package.json ui/bun.lock ui/src/api/schema.d.ts ui/src/api/encryption.ts ui/src/crypto/age.ts ui/src/crypto/__tests__
git commit -m "feat(ui): add age encryption adapter"
```

### Task 9: Add an in-memory encryption session and coordinated lock

**Files:**
- Create: `ui/src/crypto/session.ts`
- Create: `ui/src/crypto/EncryptionProvider.tsx`
- Create: `ui/src/crypto/__tests__/EncryptionProvider.test.tsx`
- Modify: `ui/src/main.tsx`

- [ ] **Step 1: Write failing session tests.** Assert identity/password are absent from serialized state; no local/session storage calls occur; lock drops the identity; wrong password leaves the prior state locked; StrictMode double-mount does not duplicate idle listeners; actions have stable identities; only primitive status changes rerender status consumers.

- [ ] **Step 2: Write failing coordinated-lock tests.** Register two editor flushers, request lock, and assert both resolve before the identity is dropped. If either rejects, lock is refused and the session remains unlocked with an error. Unregistering an editor removes its flusher.

- [ ] **Step 3: Implement a non-React `EncryptionSession`.** Keep the private identity in a closure/ref, not serializable React state. Expose `unlockWithPassword`, `unlockWithImportedIdentity`, `getIdentity`, and `clear`. Do not store the password after unwrap completes.

- [ ] **Step 4: Implement split React contexts.** Use one context for `{ status, keyId, error, lockEpoch }` and another stable context for actions. Keep the flusher registry in a ref. Use functional state updates and primitive effect dependencies. The provider may fetch the small public keyring configuration at boot to avoid an unlock waterfall; it must not import the age chunk until setup/unlock/protected-note use.

- [ ] **Step 5: Implement idle locking.** Default disabled for v1 unless the user opts in. When enabled, deduplicate pointer/keyboard/visibility listeners, use passive listeners where appropriate, and call the same coordinated lock path. Never lock by discarding an unsaved edit.

- [ ] **Step 6: Mount the provider.** Place it inside `QueryClientProvider` and outside the router in `ui/src/main.tsx` so it can coordinate query invalidation and all open folios.

- [ ] **Step 7: Run tests.**

Run: `cd ui && bun run test src/crypto/__tests__/EncryptionProvider.test.tsx && bun run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add ui/src/crypto/session.ts ui/src/crypto/EncryptionProvider.tsx ui/src/crypto/__tests__/EncryptionProvider.test.tsx ui/src/main.tsx
git commit -m "feat(ui): add in-memory encryption session"
```

---

## Phase 6 — Editor data flow

### Task 10: Decrypt protected pages without contaminating the query cache

**Files:**
- Modify: `ui/src/editor/usePageEditor.ts`
- Create: `ui/src/editor/useDecryptedPageBody.ts`
- Create: `ui/src/editor/__tests__/usePageEditor.encryption.test.tsx`

- [ ] **Step 1: Write failing load tests.** Mock a protected `PageDetail` whose `body` is armor. While locked, `markdownToSlate` must not be called and the hook returns a locked state. After unlock, it decrypts once per `{path, revision, lockEpoch}`, parses plaintext, and never calls `queryClient.setQueryData` with plaintext.

- [ ] **Step 2: Write failing lifecycle tests.** Switching paths during decryption ignores the stale result; locking remounts/clears the editor; a tampered body shows an authentication error and never opens a blank editable note; StrictMode cannot trigger two visible prompts.

- [ ] **Step 3: Implement a narrow async body hook.** It accepts the API page (ciphertext), encryption session actions, and lock epoch, returning a discriminated union:

```ts
type DecryptedBodyState =
  | { status: "plain"; body: string }
  | { status: "locked" }
  | { status: "decrypting" }
  | { status: "error"; error: string };
```

Cache only an in-memory promise/result keyed to the mounted folio revision, not a global or persistent store. Clear it on lock.

- [ ] **Step 4: Refactor editor initialization.** Feed Slate only `{status: "plain"}` bodies. Plain pages retain the current synchronous path. Expose `encryptionState` from `usePageEditor` so `Folio` can select the locked/error UI before rendering Slate.

- [ ] **Step 5: Run focused tests.**

Run: `cd ui && bun run test src/editor/__tests__/usePageEditor.encryption.test.tsx -t "load|lock|tamper"`

Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add ui/src/editor/usePageEditor.ts ui/src/editor/useDecryptedPageBody.ts ui/src/editor/__tests__/usePageEditor.encryption.test.tsx
git commit -m "feat(editor): decrypt protected pages in memory"
```

### Task 11: Encrypt autosaves and make flush awaitable

**Files:**
- Modify: `ui/src/editor/usePageEditor.ts`
- Modify: `ui/src/editor/__tests__/usePageEditor.encryption.test.tsx`
- Modify: `ui/src/editor/__tests__/usePageEditor.test.tsx`

- [ ] **Step 1: Write failing save tests.** Edit a protected page and inspect the mocked PUT request: it must contain canonical armor and must not contain the known plaintext. Decrypt the sent armor in the test and assert it equals Slate's Markdown serialization.

- [ ] **Step 2: Cover metadata-only saves.** Changing a title/tag/alias on a protected page must omit `body`, avoiding needless randomized re-encryption and full-file diffs.

- [ ] **Step 3: Cover response baselines.** The server response body is ciphertext; `savedRef.current.body` must remain the plaintext that was successfully encrypted, not `response.body`. A queued edit during encryption remains dirty and is sent next.

- [ ] **Step 4: Cover conflict reload.** A 409 reload fetches ciphertext, decrypts it, resets Slate and the plaintext baseline, and preserves the normal conflict UI. Wrong-key/tampered reload remains non-editable.

- [ ] **Step 5: Refactor save into an awaitable operation.** Replace the current void async IIFE with a single-flight `runSave(): Promise<void>` while preserving generation counters, stale-path epochs, debounce, queued saves, and draft creation. Expose `saveNow(): Promise<void>` and register it as a provider flusher only while an encrypted editor is mounted.

- [ ] **Step 6: Encrypt only at the boundary.** Serialize Slate to plaintext Markdown, dynamically call `encryptMarkdown`, then construct the request. Do not place the armor in Slate/editor state; do not place plaintext in the API/query state.

- [ ] **Step 7: Run the full editor test file.**

Run: `cd ui && bun run test src/editor/__tests__/usePageEditor.test.tsx src/editor/__tests__/usePageEditor.encryption.test.tsx`

Expected: PASS, including all existing concurrency and navigation cases.

- [ ] **Step 8: Commit.**

```bash
git add ui/src/editor/usePageEditor.ts ui/src/editor/__tests__/usePageEditor.test.tsx ui/src/editor/__tests__/usePageEditor.encryption.test.tsx
git commit -m "feat(editor): encrypt protected note saves"
```

---

## Phase 7 — Setup, protection, and locked UX

### Task 12: Implement key setup and recovery workflow

**Files:**
- Create: `ui/src/components/codex/EncryptionSetupDialog.tsx`
- Create: `ui/src/components/codex/__tests__/EncryptionSetupDialog.test.tsx`
- Modify: `ui/src/components/SettingsModal.tsx`

- [ ] **Step 1: Write failing password-setup tests.** Password confirmation mismatch, short/weak warning, generated identity/recipient, wrapped identity submitted (never password/raw identity), recovery export offered, and setup cannot finish until the user acknowledges that losing both password and recovery identity is unrecoverable.

- [ ] **Step 2: Write failing imported-key tests.** Import a textual age identity, derive/validate its recipient, submit no wrapped identity, and retain the identity only in the current session. Reject malformed or mismatched imports without logging contents.

- [ ] **Step 3: Implement with existing modal primitives.** Follow `CodexModalShell` and react-aria patterns. Generate/wrap/export only in event handlers, not effects. Disable duplicate submissions and announce errors accessibly.

- [ ] **Step 4: Add password change.** Unlock the existing wrapped identity, wrap the same identity with the new password, call the optimistic rewrap endpoint, and leave note ciphertext untouched.

- [ ] **Step 5: Run component tests.**

Run: `cd ui && bun run test src/components/codex/__tests__/EncryptionSetupDialog.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add ui/src/components/codex/EncryptionSetupDialog.tsx ui/src/components/codex/__tests__/EncryptionSetupDialog.test.tsx ui/src/components/SettingsModal.tsx
git commit -m "feat(ui): add encrypted vault key setup"
```

### Task 13: Add protect, unprotect, unlock, and preview states

**Files:**
- Create: `ui/src/components/codex/NoteProtectionDialog.tsx`
- Create: `ui/src/components/codex/LockedFolio.tsx`
- Create: `ui/src/components/codex/__tests__/NoteProtectionDialog.test.tsx`
- Create: `ui/src/components/codex/__tests__/LockedFolio.test.tsx`
- Modify: `ui/src/components/codex/Folio.tsx`
- Modify: `ui/src/editor/PageEditorHeader.tsx`
- Modify: `ui/src/components/codex/PreviewBody.tsx`
- Modify: `ui/src/components/codex/LinkPreviewLayer.tsx`
- Modify: relevant existing Folio/preview/header tests

- [ ] **Step 1: Write failing protect-flow tests.** Protecting requires an initialized/unlocked key, flushes current edits, encrypts current plaintext, calls the dedicated protect endpoint, and remounts from the encrypted response. The warning explicitly lists visible title/tags/path and unencrypted attachments/history.

- [ ] **Step 2: Write failing unprotect-flow tests.** Require unlock and destructive confirmation, flush, call the unprotect endpoint with plaintext, and return to an ordinary page. Closing/cancelling writes nothing.

- [ ] **Step 3: Write failing locked-folio tests.** A locked page renders metadata plus unlock controls but no Slate editor, preview Markdown, body-derived word count/TOC, or copyable armor. Wrong password remains locked; correct password opens the page.

- [ ] **Step 4: Write failing preview tests.** Protected pages always show a compact locked placeholder in hover/tab previews in v1, even if another folio is unlocked. This avoids proliferating plaintext and crypto work across transient components.

- [ ] **Step 5: Implement controls and badges.** Add a protection row to the Folio document metadata and a lock control in the header. Keep dialog code dynamically separated where practical; do not import the age package directly.

- [ ] **Step 6: Implement manual lock.** The control invokes provider `requestLock`, awaits every open encrypted editor flusher, then clears the session and remounts protected folios. If a save fails, show the error and stay unlocked.

- [ ] **Step 7: Run UI tests.**

Run: `cd ui && bun run test src/components/codex/__tests__/NoteProtectionDialog.test.tsx src/components/codex/__tests__/LockedFolio.test.tsx src/components/codex/__tests__/Folio.test.tsx src/editor/__tests__/PageEditorHeader.test.tsx`

Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add ui/src/components/codex ui/src/editor/PageEditorHeader.tsx ui/src/editor/__tests__/PageEditorHeader.test.tsx
git commit -m "feat(ui): add protected note controls and locked states"
```

---

## Phase 8 — Secondary backend consumers and clients

### Task 14: Audit every body consumer and fail safely

**Files:**
- Modify as required: `src/api/index_routes.rs`, `src/api/blocks.rs`, `src/api/journal.rs`, `src/api/tasks.rs`, `src/api/agenda.rs`
- Modify as required: `src/vault/mutation.rs`, `src/vault/rewriter.rs`, `src/vault/grep.rs`, `src/vault/tree.rs`
- Modify: `src/lsp/document.rs`, `src/lsp/diagnostics.rs`, `src/lsp/hover.rs`, `src/lsp/symbols.rs`, `src/lsp/mod.rs`
- Modify/add focused tests in existing API, mutation, tree, grep, and LSP test files

- [ ] **Step 1: Produce the body-consumer checklist.** Run:

Run: `rg -n 'page\.body|\.body\.split|parse_blocks|extract_links|read_to_string|find_body_start|body_offset' src/api src/vault src/lsp`

Classify each result as: metadata-only safe; already suppressed by index; direct file/body consumer requiring a guard; or mutation that must reject protected pages. Add the final classification as a comment block to the task notes before editing.

<!-- Task 14 body-consumer audit (2026-08-07)
metadata-only safe:
- `src/api/pages.rs` detail/protect/unprotect/update/assign reads intentionally return or preserve armor; ordinary protected-body updates already validate armor. Stale-revision reads are CAS checks.
- `src/api/properties.rs`, `src/api/board/{cycles,tasks}.rs`, and `src/vault/academic_hook.rs` change frontmatter while preserving the parsed body unchanged.
- `src/api/archive.rs` reads only for exact compensation comparison; `src/api/academic.rs` detail/list reads expose the stored body like page detail, while its metadata mutations preserve that body.
- `src/vault/{keyring,location,migrate,checkpoint,new_note,base,config,bcl,init,page}.rs`, API test/support reads, and reconcile tests read configuration, key material, fixtures, or whole pages for parsing/CAS rather than deriving plaintext projections.

already suppressed by index:
- `src/vault/index.rs` blanks `body` before `extract_links`, `parse_blocks`, FTS, derivers, and word counts whenever encryption metadata is present; both incremental and full builds retain raw armor only for exact persistence.
- `src/vault/derivers/links.rs` consumes the already-suppressed indexed link list. Index-backed block search, task/agenda queries, backlink context, and grep therefore have no protected body rows/content.
- `src/vault/tree.rs` loads indexed `encrypted` and nullable `word_count`; it needs only a visible encrypted marker in human output.

direct file/body consumer requiring a guard or empty projection:
- `src/api/index_routes.rs` derives content-index descriptions and word counts directly from `Page::body`.
- `src/lsp/document.rs` stores armor as body and extracts links; this is the central guard point for body completion, hover-at-position, symbols, references, rename, block actions, and body diagnostics.
- `src/lsp/mod.rs` direct file reads used for hover previews and throwaway documents must inherit/check encrypted state so armor is never previewed or edited.
- `src/vault/index.rs` backlink-context file reads are safe for current encrypted rows because body links are suppressed, but the indexed-source invariant is documented and tested rather than re-parsing armor.

mutation that must reject or skip protected pages:
- `src/api/blocks.rs` block-ID assignment and `src/api/tasks.rs` task-status byte edits must reject protected targets before offset parsing or writes.
- `src/api/journal.rs` capture must reject an already-protected daily page before appending.
- `src/vault/mutation.rs` move/delete/folder backlink rewrite planning must skip protected referring pages while continuing to rewrite plaintext referrers.
- `src/vault/rewriter.rs` remains a pure Markdown rewriter; callers are responsible for the protected-page guard.
-->

- [ ] **Step 2: Write failing API tests.** Protected pages must have empty description and `word_count: null` in content-index, no block-search/assignment results, and no body-derived task/agenda/journal entries. Metadata-backed listings may still include the page with `encrypted: true`.

- [ ] **Step 3: Write failing rewrite tests.** Link rename/move/delete planning must never rewrite bytes inside a protected body. Inbound links from plain pages continue to rewrite normally. Block-ID assignment to a protected page returns a conflict/bad request rather than touching armor.

- [ ] **Step 4: Write failing CLI/index tests.** `clep grep` does not return ciphertext tokens or prior plaintext, while a title match may return the protected page without a body snippet. Tree output uses an encrypted indicator and no word count.

- [ ] **Step 5: Write failing LSP tests.** Opening a protected document produces one informational `Encrypted note body is unavailable to the LSP` diagnostic; hover, symbols, references, rename, block actions, and body completion return no body-derived results. Frontmatter completion remains available.

- [ ] **Step 6: Add explicit guards.** Prefer `Page::is_encrypted()` or indexed `encrypted` over rechecking armor. Reject writes where semantics would require plaintext; return empty/unknown projections where reads can degrade safely.

- [ ] **Step 7: Rerun the audit and tests.** Every direct body consumer must now have a test or a documented reason it is safe.

Run: `cargo test --test api_encryption_test -- --nocapture && cargo test --test mutation_test encrypted -- --nocapture && cargo test --test lsp_document_test encrypted -- --nocapture && cargo test grep:: --lib`

Expected: PASS.

<!-- Task 14 final audit disposition:
- API content-index, block assignment, task status, and journal capture now use explicit encryption guards; covered by `api_encryption_test` encrypted projection/mutation tests.
- Move/delete/folder rewrite planning checks parsed encryption metadata before invoking the Markdown rewriter; covered by stale-index protected-referrer tests in `mutation_test` while plaintext referrers remain writable.
- Incremental/full index suppression, FTS replacement, grep title-only behavior, and nullable word counts are covered by index/encryption and `vault::grep` tests; tree rendering adds a lock and defensively omits word count for encrypted metadata.
- `lsp::Document` retains frontmatter/rope state but blanks body and links, rejects body positions, and emits one informational encrypted-body diagnostic; backend completion, hover preview, references, rename preparation/execution, symbols, referrer edits, and range fallbacks inherit or explicitly check that state.
- Remaining `read_to_string` audit hits are configuration/keyring reads, exact CAS/compensation reads, metadata-only frontmatter mutations that preserve the body, public detail endpoints intentionally returning armor for client-side decryption, index paths that blank before derivation, or test fixtures.
-->

- [ ] **Step 8: Commit.**

```bash
git add src/api src/vault src/lsp tests
git commit -m "feat: make body consumers encryption-aware"
```

### Task 15: Verify the responsive web client handles encrypted notes

**Files:**
- Modify: `ui/src/components/codex/{Folio,PreviewBody,LinkPreviewLayer}.tsx`
- Modify: `ui/src/editor/{usePageEditor,PageEditorHeader}.tsx`
- Modify: `ui/src/editor/__tests__/usePageEditor.encryption.test.tsx`

- [ ] **Step 1: Verify locked/read and decrypt/edit states.** Protected pages show metadata and an explicit locked state until the in-memory frontend identity is available.

- [ ] **Step 2: Verify encrypted writes.** After unlock, edits decrypt before presentation and re-encrypt before every body write; ordinary saves never send armored ciphertext as Markdown.

- [ ] **Step 3: Run focused frontend encryption tests.**

Run: `bun --cwd ui test src/editor/__tests__/usePageEditor.encryption.test.tsx`

Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add ui/src/components/codex ui/src/editor
git commit -m "test: verify encrypted notes in responsive web"
```

---

## Phase 9 — Hardening, documentation, and release gate

### Task 16: Add browser hardening and explicit security documentation

**Files:**
- Modify: `src/api/frontend.rs`
- Modify/add frontend response-header tests
- Create: `docs/encrypted-notes.md`
- Modify: `docs/configuration.md`
- Modify: `README.md`

- [ ] **Step 1: Inventory the production frontend.** Confirm whether Vite emits inline scripts/styles, which external image/font/connect sources the app intentionally uses, and whether development and production need different policies.

- [ ] **Step 2: Write failing header tests.** Production frontend responses must include a Content Security Policy with no `unsafe-eval`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and a suitable frame policy. Preserve SSE/API connectivity and the existing embedded-asset handler.

- [ ] **Step 3: Implement headers centrally.** Add them to both index and asset responses. Keep `script-src` self-only. Permit inline styles only if the current React/Tailwind runtime requires them; document the reason in code.

- [ ] **Step 4: Write the user/security guide.** Include:

  - what is and is not encrypted;
  - first setup, recovery export, import-key mode, password change;
  - manual/idle lock behavior;
  - loss of meaningful line diffs for encrypted bodies;
  - no search/outlinks/blocks/LSP body semantics in v1;
  - attachments, filenames, metadata, Git history, backups, browser memory, and malicious-client limitations;
  - cache scrub behavior and its storage-device limitations;
  - recovery is impossible if all unlock material is lost.

- [ ] **Step 5: Add configuration documentation.** Document any idle-lock setting and `.clepsydra/crypto/` files, clearly marking the wrapped identity as sensitive ciphertext that still belongs in backups.

- [ ] **Step 6: Run focused tests.**

Run: `cargo test frontend --lib && cargo test --test api_encryption_test -- --nocapture`

Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/api/frontend.rs docs/encrypted-notes.md docs/configuration.md README.md tests
git commit -m "docs: document encrypted notes security model"
```

### Task 17: Run leak tests and complete the release gate

**Files:**
- Create or modify: `tests/e2e_encryption_test.rs`
- Modify frontend tests only if verification reveals a real gap

- [ ] **Step 1: Add an end-to-end known-secret test.** Through the HTTP API and frontend crypto adapter (or a fixed interoperable fixture), create a plaintext page, protect it, edit it, lock it, restart/reopen the index, and assert the unique marker is absent from:

  - the note file;
  - page GET/PUT bodies captured after protection;
  - `.clepsydra/cache.db`, `-wal`, and `-shm`;
  - keyring files;
  - application logs captured by the test;
  - localStorage/sessionStorage and serialized Zustand state in the UI harness.

- [ ] **Step 2: Add destructive-path tests.** Wrong password/key, tampered armor, stale protect/unprotect, save failure during lock, external file change while unlocked, malformed keyring, missing wrapped identity, and lost imported identity all fail without plaintext overwrite.

- [ ] **Step 3: Run the complete backend gates.**

Run: `cargo fmt --check`

Run: `cargo clippy --all-targets --all-features -- -D warnings`

Run: `cargo test --all-targets --all-features`

Expected: all PASS.

- [ ] **Step 4: Run the complete frontend gates.**

Run: `cd ui && bun run typecheck`

Run: `cd ui && bun run lint`

Run: `cd ui && bun run test`

Run: `cd ui && bun run build`

Run: `cd ui && bun run knip`

Expected: all PASS; `age-encryption` remains a lazy chunk.

- [ ] **Step 5: Run responsive browser gates.**

Run: `bun --cwd ui test src/docs/mdx-smoke.test.tsx src/docs/registry.test.ts src/docs/search.test.ts`

Expected: PASS.

- [ ] **Step 6: Perform manual interoperability checks.** Protect a note in Clepsydra, extract its body armor, decrypt it with a stable age CLI using the recovery identity, edit and re-encrypt it externally, replace the body without changing the TOML marker, and confirm Clepsydra opens it. Repeat password unwrap with a wrapped identity fixture.

- [ ] **Step 7: Request a security-focused code review.** The reviewer must inspect: no plaintext API path for a page that remains protected; explicit protect/unprotect transition atomicity; ordinary-update fail-closed behavior; SQLite/WAL scrubbing; identity/password lifecycle; bundle loading; cache/storage/log leaks; CSP; and recovery docs.

- [ ] **Step 8: Commit final test adjustments.**

```bash
git add tests/e2e_encryption_test.rs ui/src
git commit -m "test: verify encrypted notes end to end"
```

---

## Explicit follow-ups, not part of v1

- Passkey/WebAuthn or hardware-security-key wrapping. Do not invoke an authenticator on every autosave; unwrap the vault identity once per session.
- Multiple recipients, sharing, recipient removal, and key rotation.
- Encrypted attachments and attachment-key lifecycle.
- Client-side search over unlocked notes. Any persistent local search index must itself be encrypted and separately threat-modeled.
- Title/path/tag encryption or opaque filenames; these materially change navigation and sync semantics.
- Per-note independent passwords.
- Decrypted transient hover previews.

## Definition of done

The feature is done only when a protected note is normal to read and edit after one frontend unlock, remains a text-based interoperable age envelope on disk, cannot be accidentally downgraded by ordinary writes, leaves no known plaintext in Clepsydra's files/cache/network/persistent browser state after protection, and degrades every non-decrypting client or body-derived feature explicitly rather than corrupting data or pretending it is available.
