# Book ISBN Import Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a command-palette book importer with explicit ISBN submission, optional camera barcode capture, canonical server-side ISBN handling, and an in-app guide.

**Architecture:** Keep the existing academic import endpoint and make it authoritative for ISBN normalization. Add a reusable root overlay whose manual-import path uses the generated OpenAPI client, while a separately lazy-loaded ZXing adapter owns camera decoding so the future Library screen can reuse the workflow without coupling to the command palette.

**Tech Stack:** Rust 2024/Axum, React 19, TypeScript 5.9, Zustand, TanStack Query/OpenAPI, React Testing Library/Vitest, `@zxing/browser`, MDX.

---

### Task 1: Canonical ISBN contract

**Files:**
- Modify: `src/vault/import_isbn.rs`
- Modify: `src/api/academic.rs:644-692`
- Test: `tests/import_test.rs`
- Test: `tests/academic_dedup_test.rs`

**Step 1: Write failing domain tests**

Add table-driven tests for `normalize_isbn` covering ISBN-13, separated ISBN-13,
ISBN-10 conversion, lowercase `x`, invalid check digits, invalid characters, and
invalid lengths. The public API should be:

```rust
pub fn normalize_isbn(input: &str) -> Result<String, String>
```

It returns canonical ISBN-13 digits.

**Step 2: Verify the domain tests fail**

Run: `cargo test --test import_test normalize_isbn`

Expected: FAIL because `normalize_isbn` does not exist.

**Step 3: Implement minimal normalization**

Strip ASCII spaces and hyphens, validate ISBN-10 or ISBN-13 check digits, and
convert ISBN-10 by prefixing `978`, retaining the first nine digits, and deriving
the ISBN-13 check digit. Reject every other character or length.

**Step 4: Verify the domain tests pass**

Run: `cargo test --test import_test normalize_isbn`

Expected: PASS.

**Step 5: Write failing handler tests**

Extend the existing ISBN dedup integration coverage so a separated ISBN-10
request skips a page indexed with its canonical ISBN-13. Add an invalid ISBN
request asserting `400` without an Open Library request.

**Step 6: Verify the handler tests fail**

Run: `cargo test --test academic_dedup_test import_isbn`

Expected: FAIL because the handler deduplicates the raw request and invalid input
falls through to the network path.

**Step 7: Normalize before deduplication and fetch**

Call `normalize_isbn` at the top of `import_isbn_handler`, map validation errors
to `ApiError::bad_request`, and use the canonical value for deduplication,
Open Library lookup, parsing, and stored metadata.

**Step 8: Verify the handler tests pass**

Run: `cargo test --test academic_dedup_test import_isbn`

Expected: PASS.

**Step 9: Commit**

```bash
git add src/vault/import_isbn.rs src/api/academic.rs tests/import_test.rs tests/academic_dedup_test.rs
git commit -m "feat(academic): canonicalize ISBN imports"
```

### Task 2: Frontend ISBN model and typed API mutation

**Files:**
- Create: `ui/src/lib/isbn.ts`
- Create: `ui/src/lib/isbn.test.ts`
- Create: `ui/src/api/academic.ts`

**Step 1: Write failing ISBN model tests**

Mirror the server vectors and require:

```ts
export function normalizeIsbn(input: string): string | null
```

The return value is canonical ISBN-13 or `null`.

**Step 2: Verify the tests fail**

Run: `bun run test src/lib/isbn.test.ts`

Expected: FAIL because the module does not exist.

**Step 3: Implement the minimal pure model**

Implement the same stripping, check-digit validation, and ISBN-10 conversion as
the server. Keep regular expressions hoisted at module scope.

**Step 4: Verify the tests pass**

Run: `bun run test src/lib/isbn.test.ts`

Expected: PASS.

**Step 5: Add the generated-client hook**

Add:

```ts
export const useImportIsbn = () =>
  $api.useMutation("post", "/api/vault/academic/import/isbn");
```

No handwritten response types or duplicate fetch wrapper.

**Step 6: Run typecheck and commit**

Run: `bun run typecheck`

Expected: PASS.

```bash
git add ui/src/lib/isbn.ts ui/src/lib/isbn.test.ts ui/src/api/academic.ts
git commit -m "feat(ui): add ISBN model and import mutation"
```

### Task 3: Reusable book-import overlay entry point

**Files:**
- Modify: `ui/src/store/ui.ts`
- Modify: `ui/src/store/ui.test.ts`
- Modify: `ui/src/components/codex/CommandPalette.tsx`
- Modify: `ui/src/components/codex/__tests__/CommandPalette.test.tsx`
- Modify: `ui/src/routes/__root.tsx`
- Modify: `ui/src/routes/__tests__/-root-overlays.test.tsx`

**Step 1: Write failing state and palette tests**

Require `openBookImport`/`closeBookImport`, and require the **Add book by ISBN**
palette command to close search and open book import.

**Step 2: Verify the tests fail**

Run:

```bash
bun run test src/store/ui.test.ts src/components/codex/__tests__/CommandPalette.test.tsx
```

Expected: FAIL because the state and command are absent.

**Step 3: Implement store state and command**

Add the boolean and actions to `useUiStore`. Add a command with id
`library.add-book`; dispatch `close()` before `openBookImport()`.

**Step 4: Verify state and palette tests pass**

Run the same focused command.

Expected: PASS.

**Step 5: Write the failing overlay test**

Mock `BookImportModal`, activate `isBookImportOpen`, and assert the root mounts
the lazy overlay with the accessible label **Add book** only while active.

**Step 6: Verify the overlay test fails**

Run: `bun run test src/routes/__tests__/-root-overlays.test.tsx`

Expected: FAIL because the root overlay is absent.

**Step 7: Add the lazy root boundary**

Lazy-import `BookImportModal`, select the new store state, and wrap it in an
`OverlayBoundary` with `closeBookImport`.

**Step 8: Verify and commit**

Run: `bun run test src/store/ui.test.ts src/components/codex/__tests__/CommandPalette.test.tsx src/routes/__tests__/-root-overlays.test.tsx`

Expected: PASS.

```bash
git add ui/src/store/ui.ts ui/src/store/ui.test.ts ui/src/components/codex/CommandPalette.tsx ui/src/components/codex/__tests__/CommandPalette.test.tsx ui/src/routes/__root.tsx ui/src/routes/__tests__/-root-overlays.test.tsx
git commit -m "feat(ui): open book import from command palette"
```

### Task 4: Manual ISBN import modal

**Files:**
- Create: `ui/src/components/books/BookImportModal.tsx`
- Create: `ui/src/components/books/__tests__/BookImportModal.test.tsx`

**Step 1: Write failing manual-flow tests**

Mock `useImportIsbn` and `useOpenTab`. Cover focus, invalid input staying local,
canonical request body, created response, skipped response, API error retention,
pending-state disablement, Escape, and reset after dismissal.

**Step 2: Verify the tests fail**

Run: `bun run test src/components/books/__tests__/BookImportModal.test.tsx`

Expected: FAIL because the modal does not exist.

**Step 3: Implement the minimal modal**

Use `CodexModalShell`, a semantic form, `normalizeIsbn`, `formatApiError`, and the
typed mutation. Submit `{ body: { isbn } }`; on `created` or `skipped`, close and
open `page_path` through `useOpenTab`. Do not infer a title unavailable in the
response; use **Imported book** as the temporary tab label.

**Step 4: Verify the tests pass**

Run the focused modal suite.

Expected: PASS.

**Step 5: Run focused integration suites and commit**

Run:

```bash
bun run test src/lib/isbn.test.ts src/components/books/__tests__/BookImportModal.test.tsx src/components/codex/__tests__/CommandPalette.test.tsx src/routes/__tests__/-root-overlays.test.tsx
```

Expected: PASS.

```bash
git add ui/src/components/books/BookImportModal.tsx ui/src/components/books/__tests__/BookImportModal.test.tsx
git commit -m "feat(ui): add manual ISBN book import modal"
```

### Task 5: Camera barcode capture

**Files:**
- Modify: `ui/package.json`
- Modify: `ui/bun.lock`
- Create: `ui/src/components/books/book-barcode-scanner.ts`
- Create: `ui/src/components/books/book-barcode-scanner.test.ts`
- Create: `ui/src/components/books/BookBarcodeScanner.tsx`
- Create: `ui/src/components/books/__tests__/BookBarcodeScanner.test.tsx`
- Modify: `ui/src/components/books/BookImportModal.tsx`
- Modify: `ui/src/components/books/__tests__/BookImportModal.test.tsx`

**Step 1: Add the scanner dependency**

Run: `bun add @zxing/browser`

Expected: `package.json` and `bun.lock` update.

**Step 2: Write failing scanner-adapter tests**

Mock the dynamically imported ZXing module and require an adapter that starts a
rear-camera scan, forwards decoded text, ignores decode misses, and exposes a
stop control.

**Step 3: Verify the adapter tests fail**

Run: `bun run test src/components/books/book-barcode-scanner.test.ts`

Expected: FAIL because the adapter is absent.

**Step 4: Implement the dynamic adapter**

Import `@zxing/browser` inside the start function, construct a one-dimensional
reader, call `decodeFromConstraints` with `facingMode: { ideal: "environment" }`,
and return its controls. The top-level modal chunk must not statically import the
scanner package.

**Step 5: Verify the adapter tests pass**

Run the focused adapter suite.

Expected: PASS.

**Step 6: Write failing scanner component tests**

Mock the adapter and media tracks. Cover valid capture, invalid decoded values,
explicit cancel, permission denial, unavailable media APIs, and cleanup on
unmount. Require valid capture to call `onCapture` without importing.

**Step 7: Verify the component tests fail**

Run: `bun run test src/components/books/__tests__/BookBarcodeScanner.test.tsx`

Expected: FAIL because the component is absent.

**Step 8: Implement scanner lifecycle and modal integration**

Render the live `<video>` and status in `BookBarcodeScanner`. Stop decoder
controls and every `video.srcObject` track idempotently. In `BookImportModal`,
the scan button toggles the component; `onCapture` fills the field, closes the
scanner, announces capture, and does not call the import mutation.

**Step 9: Verify scanner and modal behavior**

Run:

```bash
bun run test src/components/books/book-barcode-scanner.test.ts src/components/books/__tests__/BookBarcodeScanner.test.tsx src/components/books/__tests__/BookImportModal.test.tsx
```

Expected: PASS.

**Step 10: Verify bundle boundaries and commit**

Run: `bun run build`

Expected: PASS; `BookImportModal` and ZXing emit separate lazy chunks.

```bash
git add ui/package.json ui/bun.lock ui/src/components/books
git commit -m "feat(ui): scan book barcodes with the camera"
```

### Task 6: Books and Reading documentation

**Files:**
- Create: `ui/src/docs/content/books-and-reading.mdx`
- Modify: `ui/src/docs/registry.ts`
- Modify: `ui/src/docs/registry.test.ts`
- Modify: `ui/src/docs/mdx-smoke.test.tsx`
- Modify: `ui/src/components/docs/__tests__/DocsSidebar.test.tsx`

**Step 1: Write failing registry and smoke assertions**

Require **Features** to contain `bases` followed by `books-and-reading`, require
the registry metadata, render the new MDX module, and update the exact sidebar
link count.

**Step 2: Verify the docs tests fail**

Run:

```bash
bun run test src/docs/registry.test.ts src/docs/mdx-smoke.test.tsx src/components/docs/__tests__/DocsSidebar.test.tsx
```

Expected: FAIL because the guide is absent.

**Step 3: Add the guide and registry entry**

Document command-palette access, explicit confirmation after scanning, metadata,
destination configuration, duplicate behavior, HTTPS/loopback camera rules,
permissions, lookup failures, limitations, and the future Library-screen plan.

**Step 4: Verify docs tests pass**

Run the focused docs command.

Expected: PASS.

**Step 5: Commit**

```bash
git add ui/src/docs/content/books-and-reading.mdx ui/src/docs/registry.ts ui/src/docs/registry.test.ts ui/src/docs/mdx-smoke.test.tsx ui/src/components/docs/__tests__/DocsSidebar.test.tsx
git commit -m "docs: add Books and Reading guide"
```

### Task 7: Full verification and browser smoke

**Files:**
- Modify only if verification exposes a defect, with a failing regression test first.

**Step 1: Format and inspect**

Run:

```bash
cargo fmt --check
bun run format
git diff --check
```

If the formatter changes files, inspect them, rerun focused tests, and commit the
mechanical result with the relevant checkpoint rather than hiding behavior
changes in a formatting-only commit.

**Step 2: Run complete UI gates**

Run:

```bash
bun run typecheck
bun run lint
bun run test
bun run build
```

Expected: all pass. Confirm the scanner remains a separate lazy chunk.

**Step 3: Run complete Rust gates**

Run:

```bash
cargo test
cargo clippy --all-targets --all-features -- -D warnings
```

Expected: all pass after `ui/dist` has been built.

**Step 4: Browser smoke**

Start the server on an available loopback port and use the Playwright workflow to
open the command palette, launch **Add book by ISBN**, verify manual validation,
and verify opening scanner mode requests camera or shows the environment-specific
camera error without breaking manual entry. Do not perform a live Open Library
import against the user's vault; use a temporary vault or intercept the endpoint.

**Step 5: Review the branch diff**

Run:

```bash
git status --short
git log --oneline --decorate -8
git diff develop...HEAD --check
git diff --stat develop...HEAD
```

Expected: only planned files, clean worktree, checkpoint commits present.
