# Protected Attachment Acknowledgement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require explicit acknowledgement that attachments and identifying metadata remain plaintext, with per-action confirmation inside protected notes and persistent warnings for existing references.

**Architecture:** The attachment upload API requires a `plaintext_acknowledged=true` multipart field for every upload because attachments are global, not page-owned. `AttachmentManager` owns the action-scoped disclosure state for protected upload and insertion. A pure Markdown-reference extractor derives the protected-note audit list in the decrypted client; the server never receives decrypted note content for this feature.

**Tech Stack:** Rust/Axum multipart handling, OpenAPI/utoipa, React 19, TypeScript, TanStack Query, React Aria dialog primitives, Slate Markdown serialization, Vitest/Testing Library.

## Global Constraints

- Attachments remain plaintext; do not add blob encryption or migration.
- The disclosure names bytes, filename, path, MIME type, and size as plaintext metadata.
- Upload acknowledgement is server-enforced for every attachment upload.
- Insertion of already-uploaded attachments into ciphertext is client-enforced because the server cannot inspect encrypted bodies.
- Acknowledgement is action-scoped; no persistent opt-out or “never warn again.”
- Cancelling leaves both attachment storage and page content unchanged.
- Do not send decrypted attachment-reference inventories to the server.
- Follow TDD and observe intended failures before implementation.

---

### Task 1: Require upload acknowledgement in the attachment API

**Files:**
- Modify: `src/api/attachments.rs:221-318`
- Modify: `src/api/openapi.rs`
- Modify: `tests/api_test.rs`

**Interfaces:**
- Produces multipart fields:
  - `file`: exactly one file field
  - `plaintext_acknowledged`: exactly one UTF-8 field whose value is `true`
- Rejection: HTTP 400 with `attachment plaintext storage must be acknowledged` before final installation.
- Preserves streaming to a temporary file and atomic no-replace installation.

- [ ] **Step 1: Add failing API tests for missing, false, and true acknowledgement**

```rust
#[tokio::test]
async fn attachment_upload_requires_plaintext_acknowledgement() {
    let (server, _tmp) = setup_server();
    multipart_upload(&server, "missing.txt", b"secret", None)
        .await
        .assert_status_bad_request();
    multipart_upload(&server, "false.txt", b"secret", Some(false))
        .await
        .assert_status_bad_request();
    multipart_upload(&server, "accepted.txt", b"secret", Some(true))
        .await
        .assert_status(axum::http::StatusCode::CREATED);
}

#[tokio::test]
async fn rejected_upload_leaves_no_destination_or_temporary_file() {
    let (server, tmp) = setup_server();
    multipart_upload(&server, "rejected.bin", b"bytes", None)
        .await
        .assert_status_bad_request();
    assert!(!tmp.path().join("vault/_attachments/rejected.bin").exists());
    assert_no_attachment_temporaries(&tmp);
}
```

Update every existing multipart fixture to include `plaintext_acknowledged=true` when testing a successful or post-ack failure path. Preserve one missing-ack fixture as the new negative contract.

- [ ] **Step 2: Run focused API tests**

Run: `cargo test --test api_test attachment_ -- --nocapture`  
Expected: FAIL because upload currently consumes only the first multipart field and accepts it without acknowledgement.

- [ ] **Step 3: Parse named multipart fields in arbitrary order**

Iterate all fields. Stream `file` into the existing temporary file, parse the acknowledgement text, reject duplicate file/ack fields, reject unknown binary fields, and require both fields before `install_noreplace`. Do not install the destination before the acknowledgement has been validated.

Document the multipart contract in utoipa rather than describing the body only as an opaque string. If utoipa cannot express the multipart object directly, add an `AttachmentUploadForm` schema solely for OpenAPI documentation while retaining streaming extraction at runtime.

- [ ] **Step 4: Run attachment API tests**

Run: `cargo test --test api_test attachment_ -- --nocapture`  
Expected: PASS, including cancellation, partial upload, duplicate destination, and race tests.

- [ ] **Step 5: Commit**

```bash
git add src/api/attachments.rs src/api/openapi.rs tests/api_test.rs
git commit -m "feat(api): require plaintext attachment acknowledgement"
```

### Task 2: Send acknowledgement through the generated client hook

**Files:**
- Modify: `ui/src/api/attachments.ts:48-73`
- Modify: `ui/src/api/__tests__/attachments.test.tsx`
- Regenerate: `ui/src/api/schema.d.ts`

**Interfaces:**
- Changes upload input to:

```ts
export interface UploadAttachmentInput {
  file: File;
  path?: string;
  plaintextAcknowledged: true;
}
```

- Appends `plaintext_acknowledged` as the string `"true"` in `FormData`.

- [ ] **Step 1: Write the failing hook contract test**

```tsx
it("sends the explicit plaintext acknowledgement", async () => {
  const post = vi.spyOn(fetchClient, "POST").mockResolvedValue({
    data: { name: "chart.png", path: "chart.png", size: 4 },
  } as never);
  const file = new File(["data"], "chart.png", { type: "image/png" });
  const { result } = renderHook(() => useUploadAttachment(), { wrapper: wrapper() });
  await result.current.mutateAsync({ file, plaintextAcknowledged: true });
  const form = post.mock.calls[0][2]?.body as unknown as FormData;
  expect(form.get("file")).toBe(file);
  expect(form.get("plaintext_acknowledged")).toBe("true");
});
```

- [ ] **Step 2: Run the hook test**

Run: `bun run --cwd ui test src/api/__tests__/attachments.test.tsx`  
Expected: FAIL because the hook has no acknowledgement input or multipart field.

- [ ] **Step 3: Regenerate schema and implement the typed input**

Start the API only for OpenAPI generation if required, run `bun run --cwd ui openapi`, then update the hook. Keep the literal `true` type so callers cannot accidentally pass a false value.

- [ ] **Step 4: Run typecheck and focused tests**

Run: `bun run --cwd ui typecheck`  
Run: `bun run --cwd ui test src/api/__tests__/attachments.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/attachments.ts ui/src/api/__tests__/attachments.test.tsx ui/src/api/schema.d.ts
git commit -m "feat(ui): acknowledge plaintext attachment uploads"
```

### Task 3: Add protected action confirmation for upload and insertion

**Files:**
- Create: `ui/src/components/attachments/PlaintextAttachmentDialog.tsx`
- Create: `ui/src/components/attachments/__tests__/PlaintextAttachmentDialog.test.tsx`
- Modify: `ui/src/components/attachments/AttachmentManager.tsx`
- Modify: `ui/src/components/attachments/__tests__/AttachmentManager.test.tsx`

**Interfaces:**
- Produces:

```ts
export type PendingAttachmentAction =
  | { kind: "upload"; file: File }
  | { kind: "insert"; attachment: AttachmentInfo; markdown: string };

interface PlaintextAttachmentDialogProps {
  action: PendingAttachmentAction | null;
  onCancel: () => void;
  onAcknowledge: (action: PendingAttachmentAction) => void;
}
```

- `AttachmentManager` keeps the existing props and handles protected actions internally.

- [ ] **Step 1: Write failing dialog and manager tests**

```tsx
it("cancels a protected upload without calling the upload mutation", async () => {
  render(<AttachmentManager protectedPage />);
  chooseFile("diagram.png");
  expect(screen.getByRole("dialog", { name: "Store plaintext attachment?" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(mocks.upload).not.toHaveBeenCalled();
});

it("requires a fresh acknowledgement for each protected insertion", async () => {
  render(<AttachmentManager protectedPage onInsertMarkdown={onInsert} />);
  await user.click(screen.getByRole("button", { name: "Insert diagram.png" }));
  expect(onInsert).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "I understand, insert" }));
  expect(onInsert).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Insert diagram.png" }));
  expect(screen.getByRole("dialog")).toBeVisible();
});
```

Assert the dialog text includes: attachment bytes, filename, path, MIME type, and size are not encrypted.

- [ ] **Step 2: Run focused component tests**

Run: `bun run --cwd ui test src/components/attachments/__tests__/PlaintextAttachmentDialog.test.tsx src/components/attachments/__tests__/AttachmentManager.test.tsx`  
Expected: FAIL because protected actions execute immediately and the dialog does not exist.

- [ ] **Step 3: Implement action-scoped confirmation**

Use the existing React Aria `Dialog` component. For unprotected uploads, display the plaintext disclosure adjacent to the file input and call `upload.mutateAsync({ file, plaintextAcknowledged: true })` directly. For protected actions, retain the pending `File` or attachment only until acknowledge/cancel; clear it in `finally`. Do not store acknowledgement in localStorage, context, or component state beyond the pending action.

- [ ] **Step 4: Run focused tests and accessibility lint**

Run: `bun run --cwd ui test src/components/attachments/__tests__/PlaintextAttachmentDialog.test.tsx src/components/attachments/__tests__/AttachmentManager.test.tsx`  
Run: `bun run --cwd ui lint`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/attachments/PlaintextAttachmentDialog.tsx ui/src/components/attachments/__tests__/PlaintextAttachmentDialog.test.tsx ui/src/components/attachments/AttachmentManager.tsx ui/src/components/attachments/__tests__/AttachmentManager.test.tsx
git commit -m "feat(ui): confirm plaintext protected-note attachments"
```

### Task 4: Surface existing attachment references in protected notes

**Files:**
- Create: `ui/src/lib/markdown/attachmentReferences.ts`
- Create: `ui/src/lib/markdown/attachmentReferences.test.ts`
- Modify: `ui/src/components/attachments/AttachmentManager.tsx`
- Modify: `ui/src/components/attachments/__tests__/AttachmentManager.test.tsx`
- Modify: `ui/src/components/codex/Folio.tsx:558-585`

**Interfaces:**
- Produces:

```ts
export interface AttachmentReference {
  path: string;
  label: string;
  image: boolean;
}
export function attachmentReferences(markdown: string): AttachmentReference[];
```

- Extends `AttachmentManagerProps` with `pageMarkdown?: string`.
- `Folio` passes `editor.bodyMarkdown`, which is already decrypted client-side for protected notes.

- [ ] **Step 1: Write parser tests for links, images, escapes, and non-attachment URLs**

```ts
it("returns unique vault attachment references in source order", () => {
  expect(attachmentReferences([
    "![Chart](/api/vault/attachments/research/chart%201.png)",
    "[Paper](/api/vault/attachments/paper.pdf)",
    "![Again](/api/vault/attachments/research/chart%201.png)",
    "[External](https://example.com/file.pdf)",
  ].join("\n"))).toEqual([
    { path: "research/chart 1.png", label: "Chart", image: true },
    { path: "paper.pdf", label: "Paper", image: false },
  ]);
});
```

Use the project’s Markdown AST stack rather than a regex so escaped labels and nested Markdown are handled consistently.

- [ ] **Step 2: Run parser and manager tests**

Run: `bun run --cwd ui test src/lib/markdown/attachmentReferences.test.ts src/components/attachments/__tests__/AttachmentManager.test.tsx`  
Expected: FAIL because the parser and audit list do not exist.

- [ ] **Step 3: Implement the client-only audit list**

Parse Markdown with `unified`, `remark-parse`, and `remark-gfm`; collect `link`/`image` nodes whose decoded URL begins `/api/vault/attachments/`. On protected pages with references, render a persistent warning region labeled `Plaintext attachment references` and list each filename/path. Do not perform a network mutation or send the list to telemetry.

- [ ] **Step 4: Run focused tests and protected-editor wiring test**

Run: `bun run --cwd ui test src/lib/markdown/attachmentReferences.test.ts src/components/attachments/__tests__/AttachmentManager.test.tsx src/editor/__tests__/usePageEditor.encryption.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/markdown/attachmentReferences.ts ui/src/lib/markdown/attachmentReferences.test.ts ui/src/components/attachments/AttachmentManager.tsx ui/src/components/attachments/__tests__/AttachmentManager.test.tsx ui/src/components/codex/Folio.tsx
git commit -m "feat(ui): audit plaintext links in protected notes"
```

### Task 5: Document, smoke, and verify the acknowledgement boundary

**Files:**
- Modify: `docs/encrypted-notes.md`
- Modify: `ui/src/docs/content/configuration.mdx`
- Test: `ui/src/docs/mdx-smoke.test.tsx`

**Interfaces:**
- Documents three distinct facts:
  1. attachment storage is plaintext,
  2. upload acknowledgement is server-enforced,
  3. references inserted into encrypted ciphertext are client-enforced and can be bypassed by a custom client.

- [ ] **Step 1: Add a failing docs rendering assertion**

Add an MDX smoke assertion that the configuration/encryption content renders a heading named `Protected notes and plaintext attachments` and links to attachment management.

- [ ] **Step 2: Run the docs smoke test**

Run: `bun run --cwd ui test src/docs/mdx-smoke.test.tsx`  
Expected: FAIL because the section is absent.

- [ ] **Step 3: Write the exact privacy-boundary documentation**

Avoid describing acknowledgement as encryption, authorization, or prevention. State that filenames and MIME/size metadata can disclose content even when note text is encrypted.

- [ ] **Step 4: Run smoke and repository gates**

Manual browser smoke:

1. Protect a note.
2. Select a file, cancel, and verify no attachment appears.
3. Select it again, acknowledge, and verify upload.
4. Insert it, reload the protected note, and verify the persistent warning.

Then run:

- `cargo check --all-targets --all-features`
- `cargo clippy --all-targets --all-features -- -D warnings`
- `cargo test --all-features`
- `bun run --cwd ui typecheck`
- `bun run --cwd ui lint`
- `bun run --cwd ui test`

Expected: all PASS. Record unrelated baseline failures exactly rather than claiming a clean gate.

- [ ] **Step 5: Commit**

```bash
git add docs/encrypted-notes.md ui/src/docs/content/configuration.mdx ui/src/docs/mdx-smoke.test.tsx
git commit -m "docs: explain plaintext protected-note attachments"
```

## Acceptance

- Upload without `plaintext_acknowledged=true` cannot install a file.
- Protected upload and insertion each require a fresh explicit confirmation.
- Cancellation changes neither storage nor page content.
- Existing references in decrypted protected notes remain visibly disclosed.
- No server API receives decrypted note content or an attachment-reference inventory.
- Documentation states the custom-client enforcement limitation precisely.
