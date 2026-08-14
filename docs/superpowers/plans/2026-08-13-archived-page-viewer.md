# Archived Page Viewer Implementation Plan

> Execute with `subagent-driven-development`: one fresh implementer and one scoped reviewer per task. Use strict red-green TDD and commit each reviewed task.

**Goal:** Add a dedicated archived-snapshot route that shows typed provenance above an inert, captured-bytes-only iframe.

**Architecture:** The existing page-detail endpoint remains the metadata source. A new archive view endpoint reads the snapshot blob from CAS, admits only `text/html`, and sends a maximally restrictive sandbox CSP whose only network origin is derived from server configuration. The UI route is keyed by vault page path, uses `usePage`, renders the provenance banner, and frames the snapshot by hash.

**Tech stack:** Rust 2024, Axum, utoipa/OpenAPI, React 19, TanStack Router, openapi-fetch/query, Vitest, Testing Library, Tailwind.

---

## Task 1: Serve snapshots through a configuration-bound sandbox

**Files:**
- Modify: `src/api/archive.rs`
- Modify: `src/api/mod.rs`
- Modify: `src/lib.rs`
- Test: `tests/archive_test.rs`
- Test as needed: `src/api/archive.rs`

### RED

Add focused tests proving:

1. `GET /api/vault/archive/view/{hash}` serves a stored `text/html` snapshot inline.
2. The response has `Content-Type: text/html`, `X-Content-Type-Options: nosniff`, no attachment disposition, and a bare `sandbox` CSP.
3. Each resource directive permits only the configured vault origin plus the explicitly allowed `data:`/`'unsafe-inline'` values.
4. A spoofed request `Host` cannot affect the CSP.
5. Missing hashes return 404 naming the hash.
6. Non-HTML blobs return 415 naming their content type.
7. The existing CAS endpoint still returns `attachment` for active content.

Run the narrow test(s) and capture the expected failure.

### GREEN

- Add a validated/configuration-derived archive-view origin to runtime state or a narrowly scoped router extension; never derive it from request headers.
- Add `framable_content_type`, `sandbox_headers`, and `view_snapshot`.
- Mount `GET /archive/view/{hash}` without applying the ingest body limit to unrelated GETs.
- Keep `/cas/{hash}` behavior unchanged.
- Prefer a small immutable origin value assembled once at startup; avoid rebuilding the CSP per directive or request beyond the required header value.

Run the narrow tests until green, then `cargo fmt --check` scoped to changed Rust files where possible.

### Review and commit

Review exact spec compliance and security boundaries. Fix every blocking finding, re-run focused tests, then commit.

---

## Task 2: Expose typed archive metadata in page details

**Files:**
- Modify: `src/api/pages.rs`
- Modify: `src/api/openapi.rs`
- Modify: `ui/src/api/schema.d.ts` (generated)
- Test: `src/api/pages.rs` and/or `src/api/openapi.rs`

### RED

Add tests proving the OpenAPI `PageMetaResponse` schema includes optional `archive`, with required archive identity/hash fields and optional Readability provenance fields matching stored frontmatter.

Run the focused Rust test and capture the expected failure.

### GREEN

- Add `ArchiveMetaResponse` with typed fields: `url`, optional `canonical_url`, `domain`, `captured_at`, `content_hash`, `snapshot_hash`, optional `byline`, `site_name`, `published_time`, `lang`, and `excerpt`.
- Add optional `archive` to the OpenAPI metadata mirror without changing `PageMeta` serialization or the page response wire shape.
- Register the DTO in OpenAPI components if not reached automatically.
- Start the working-tree server on port 3000, regenerate `ui/src/api/schema.d.ts` using `bun run openapi`, and stop the server.

Run focused Rust tests and UI typecheck.

### Review and commit

Review DTO/wire parity and generated schema. Fix blocking findings, verify again, then commit.

---

## Task 3: Build the full-page archived snapshot route

**Files:**
- Create: `ui/src/components/codex/ArchiveBanner.tsx`
- Create: `ui/src/routes/archive.$.tsx`
- Create tests adjacent to the component/route following repository conventions
- Generated as needed: `ui/src/routeTree.gen.ts`

### RED

Add frontend tests proving:

1. The banner renders title, linked origin URL, and capture time.
2. `site_name`, `byline`, and `published_time` render only when present.
3. A valid archive renders an iframe with `/api/vault/archive/view/{encoded hash}` and `sandbox=""` with no tokens.
4. Ordinary pages render an explanatory no-archive state with a link back to the page.
5. A missing snapshot response renders “Snapshot is no longer in the content store” and names the hash.
6. A 415 response renders the server explanation naming the corrupt content type.
7. Page-query 404 uses the existing route error/not-found handling rather than inventing a second convention.

Run the focused Vitest files and capture the expected failure.

### GREEN

- Implement a restrained provenance header specific to Clepsydra’s dossier visual language; no generic dashboard card.
- Make the live origin link explicit and external-safe (`target="_blank"`, `rel="noreferrer"`).
- Use the page path splat exactly as the approved route contract specifies.
- Use an iframe `title`, a bare `sandbox` attribute, and no `allow-*` tokens.
- Distinguish endpoint 404/415 states by observing the frame request through a same-origin preflight fetch before mounting the iframe, without downloading the successful HTML body twice if the platform permits a `HEAD` route; otherwise add a small metadata-safe server response strategy consistent with Axum routing. Do not infer iframe load success from `onLoad` alone.

Run focused tests, UI typecheck, and route generation/build as needed.

### Review and commit

Review accessibility, security invariants, route/error behavior, and React performance. Fix blocking findings, verify again, then commit.

---

## Task 4: Link archived folios to the viewer

**Files:**
- Modify: `ui/src/components/codex/Folio.tsx`
- Modify/add: focused Folio tests

### RED

Add a focused test proving an archived read-only folio with `meta.archive.snapshot_hash` exposes a “View archived snapshot” link to `/archive/<vault page path>`, while ordinary pages do not.

Run the focused test and capture the expected failure.

### GREEN

- Thread typed archive metadata through `usePageEditor` only if required by existing component boundaries; avoid a second page query.
- Place the action near the read-only archive title/provenance area, not in global navigation.
- Preserve existing reader behavior and editing rules.

Run focused tests and UI typecheck.

### Review and commit

Review clean cutover and no duplicate fetch/state. Fix blocking findings, verify again, then commit.

---

## Task 5: Runtime verification and integration gates

**Files:**
- Modify only tests/docs required by observed defects.

### Runtime proof

1. Start the working-tree server with an isolated temporary vault and known configured origin.
2. Seed or capture an archive containing CSS, an image, and SVG.
3. Browser-drive the folio link into the archive route.
4. Confirm the banner fields, back link, iframe sandbox, no external network requests, and captured CSS/image rendering.
5. Confirm SVG behavior. If attachment handling breaks SVG subresource rendering, fix the CAS endpoint using `Sec-Fetch-Dest` without weakening direct-navigation attachment protection; add regression tests.
6. Exercise no-archive, missing-hash, and wrong-content-type states.

### Required gates

Run and report:

- `cargo fmt --check`
- `cargo clippy --all-targets -- -D warnings`
- `cargo test`
- `bun run typecheck` in `ui/`
- `bun run lint` in `ui/`
- `bun run test` in `ui/`
- `bun run build` in `ui/`

Review the whole branch against the approved spec and runtime evidence. Fix all merge-blocking findings, repeat affected gates, commit, merge locally into `develop`, re-run affected merged-tree gates, and remove the feature worktree/branch.
