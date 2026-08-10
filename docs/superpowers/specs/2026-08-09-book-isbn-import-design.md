# Book ISBN Import Design

**Date:** 2026-08-09
**Status:** Approved for implementation

## Problem

Clepsydra can already import an academic work from an ISBN through
`POST /api/vault/academic/import/isbn`, but the feature is not reachable from
the product UI. Logging a physical book currently requires calling the HTTP API
or writing the page metadata by hand. Mobile users also have no way to use the
barcode already printed on a book.

The first user-facing workflow should remain small and reusable. It must not add
another Atrium action or prematurely define the future dedicated Library screen.

## Scope

This feature adds:

- a global **Add book by ISBN** command in the command palette;
- a lazy-loaded modal with manual ISBN entry;
- optional live camera scanning for book barcodes;
- client and server ISBN normalization and validation;
- navigation to the created or previously imported book page;
- a **Books and Reading** in-app documentation guide;
- focused Rust and React coverage.

A dedicated Library screen, cover-image import, description or subject import,
reading-progress editing, and an Atrium action are follow-on work.

## Decisions

1. **Command palette only.** The first entry point is globally available without
   changing the Atrium.
2. **One reusable modal.** Overlay state and the modal are independent of the
   command palette so a future Library screen can open the same flow.
3. **Explicit import.** A scan fills the ISBN field and stops the camera. The user
   must still choose **Add book**.
4. **Manual entry always works.** Camera support is optional and never blocks
   keyboard entry.
5. **Load scanning code on demand.** The barcode library is imported only after
   the user starts the camera, keeping it out of the normal application startup
   graph.
6. **Canonical ISBNs.** ISBN-10 and ISBN-13 input accepts spaces and hyphens,
   validates its check digit, and is stored as canonical ISBN-13 digits.
7. **Server authority.** The backend repeats validation and normalization so
   non-UI API clients cannot persist inconsistent new ISBN values.
8. **Reuse the academic importer.** Metadata continues to come from Open Library
   and book pages continue to use the configured academic books folder.

## User Interaction

The command palette contains **Add book by ISBN**. Activating it closes the
palette, opens the modal, and focuses the ISBN field.

The modal contains:

- an ISBN text field accepting ISBN-10 or ISBN-13 with optional separators;
- an **Add book** submit button;
- a **Scan barcode** button;
- concise inline status and error text.

Selecting **Scan barcode** asks for camera permission and shows a live video
preview. The scanner prefers the environment-facing camera. It decodes linear
barcodes locally in the browser and accepts only a value that passes ISBN
validation. On a valid scan it:

1. writes the normalized ISBN-13 into the text field;
2. stops decoding and every media track;
3. hides the preview;
4. returns focus to the ISBN field;
5. announces that the barcode was captured and awaits confirmation.

The user then chooses **Add book**. While the request is pending, duplicate
submissions and scanner activation are disabled. A `created` response closes the
modal and opens the new book page. A `skipped` response does the same for the
existing page. The UI never claims success before the server response.

Closing the modal, cancelling scanning, a successful scan, and component
unmount all stop the decoder and camera tracks.

## Component Architecture

`useUiStore` gains `isBookImportOpen`, `openBookImport`, and `closeBookImport`.
`GlobalOverlays` lazy-loads `BookImportModal` only while it is open. The command
palette invokes `closeSearch()` followed by `openBookImport()`.

The frontend is split into reusable seams:

- `ui/src/lib/isbn.ts` owns separator removal, check-digit validation, and
  ISBN-10 to ISBN-13 conversion;
- `ui/src/api/academic.ts` exposes the typed import mutation;
- `ui/src/components/books/BookBarcodeScanner.tsx` owns camera and decoder
  lifecycle;
- `ui/src/components/books/BookImportModal.tsx` owns form, mutation, feedback,
  and navigation.

The scanner module dynamically imports the browser barcode package only from the
camera-start event. `BookImportModal` itself remains a normal root-overlay lazy
chunk. This creates two bundle boundaries: ordinary app startup excludes the
entire modal, and manual ISBN use excludes the scanner dependency.

The future Library screen should call `openBookImport()` or render the same
modal, rather than copying API, validation, or scanner behavior.

## Backend Contract

The route remains:

```http
POST /api/vault/academic/import/isbn
Content-Type: application/json

{"isbn":"9780262011532"}
```

Before deduplication or network access, the handler normalizes and validates the
request. ISBN-10 is converted to its equivalent ISBN-13. Invalid input returns a
`400` response without querying Open Library or mutating the vault.

Deduplication and newly written `external_ids.isbn` use the canonical ISBN-13.
This prevents new duplicates caused only by spaces, hyphens, or ISBN-10 versus
ISBN-13 forms. Existing pages containing older noncanonical identifiers remain
readable; migrating those historical values is out of scope.

The successful response remains `ImportResult`:

```json
{
  "cite_key": "abelson1996structure",
  "status": "created",
  "page_path": "library/books/structure-and-interpretation-of-computer-programs.md"
}
```

The `skipped` response also supplies `page_path`, which is sufficient for the
client to open the existing folio.

## Error Handling

The modal distinguishes:

- **Invalid ISBN:** local validation explains that a valid ISBN-10 or ISBN-13 is
  required; the request is not sent.
- **Camera unavailable:** media APIs or a usable camera are absent; manual entry
  remains available.
- **Permission denied:** the user is told to allow camera access or enter the
  ISBN manually.
- **No valid barcode yet:** decoding continues without noisy repeated errors.
- **Scanner failure:** the preview closes, tracks stop, and manual entry remains.
- **Open Library miss or network error:** the server message is shown while the
  normalized ISBN stays in the field for correction or retry.
- **Unexpected API error:** the existing API error formatter supplies a concise
  message.

Camera access requires a secure browser context except on loopback development
origins. The documentation calls this out explicitly.

## Documentation

Add `ui/src/docs/content/books-and-reading.mdx` under the **Features** group,
after Bases. It documents:

- opening **Add book by ISBN** from the command palette;
- manual entry and accepted ISBN formats;
- barcode scanning, permission, secure-context, and camera requirements;
- metadata imported from Open Library;
- the default `library/books` destination and its configuration key;
- duplicate behavior;
- current limitations and the planned dedicated Library screen boundary;
- troubleshooting lookup and camera errors.

The registry and search index consume the new source exactly like existing
guides.

## Testing

### Rust

- valid ISBN-10 and ISBN-13 normalization;
- separator removal and check-digit rejection;
- canonical ISBN-10 to ISBN-13 conversion;
- invalid requests fail before network access;
- deduplication and creation use canonical ISBN-13.

### React

- ISBN parsing and check-digit edge cases;
- palette command closes search and opens the modal;
- root overlay lazy-load contract;
- manual submit sends canonical ISBN-13;
- created and skipped responses close and open the returned page;
- invalid input stays local;
- API errors preserve the entered ISBN;
- scanner success fills the field but does not submit;
- decoder and media cleanup on capture, cancellation, close, and unmount;
- camera denial and unavailable-device messages;
- docs registry hierarchy and MDX smoke rendering.

### Verification gates

- focused Rust tests;
- focused Vitest suites;
- complete UI typecheck, lint, test, and production build;
- complete Rust formatting, test, and Clippy gates after `ui/dist` exists;
- a browser smoke test on loopback, plus camera lifecycle inspection where the
  test environment permits a mocked media stream.

