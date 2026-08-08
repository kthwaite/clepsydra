# RSS reader review fixes

## Scope

Resolve all eight findings from the review of PR #5 without expanding the RSS reader feature. Success means the destructive cases have regression coverage, the server is safe by default, filtered UI views stay coherent after mutations, and every repository verification gate passes.

## Decisions

### Network boundary

Bind the HTTP server to loopback by default. Allow an explicit bind address through configuration, but do not silently expose the unauthenticated API. Centralize outbound HTTP in a checked request path that rejects non-HTTP(S) URLs, loopback/private/link-local/reserved destinations, and unsafe redirect targets. Disable reqwest's automatic redirects so every hop is validated.

Responses are streamed under a configurable hard byte limit. Oversized feed-entry bodies are not stored; the original URL remains available. This avoids malformed HTML truncation and keeps the database bounded.

Alternative rejected: hostname string checks alone. They miss DNS resolution and redirect-based SSRF. A full authentication subsystem is also out of scope; loopback-default operation preserves the existing single-user model.

### Manifest integrity

A manifest containing parser warnings is not a valid reconciliation candidate. Reconciliation updates visible warnings but retains the last good database subscription set. API mutations use one async manifest lock around read, validation, transformation, write, and reconciliation. Before rename, the original content is re-read; a mismatch reports a conflict rather than overwriting an external edit.

Alternative rejected: a manifest actor. It provides serialization but adds unnecessary lifecycle and messaging machinery for a single small file.

### API correctness

A missing bulk-read cursor remains valid and means unbounded scope. A supplied malformed cursor returns HTTP 400 and performs no update. OPML import deduplicates against both existing subscriptions and earlier entries in the same import.

### UI cache behavior

Entry cache updates inspect each query's filters. A mutation removes entries that stop matching unread, saved, or tag views while updating entries that remain eligible. Failed mutations restore the captured cache snapshot; settled mutations refresh feed counts.

Alternative rejected: unconditional entry-query invalidation. It is correct but discards the promised immediate optimistic behavior and causes avoidable network work.

## Testing

Add focused tests for address classification and redirect/body limits, invalid-manifest preservation and serialized/conflict-aware writes, malformed bulk cursors, OPML duplicate imports, and filtered cache membership. Preserve existing manifest/parser/API tests. Final verification runs Rust formatting, typecheck, Clippy, and tests plus UI typecheck, lint, tests when configured, and production build.

## Delivery

Commit the fixes on the PR branch and push them to `claude/rss-reader-plan-nhqekq`, leaving the user's dirty `develop` checkout untouched.
