# AI Conversation Folio Design

**Status:** Approved design
**Date:** 2026-08-09

## Summary

Clepsydra will add `AI_CONVERSATION` as a first-class page kind and a dedicated MCP capture affordance. A user can tell ChatGPT or Claude to send the visible current conversation to Clepsydra. The host model supplies ordered user/assistant turns to the MCP tool; Clepsydra creates a conversation Folio or safely appends unseen turns to an existing one.

Conversation pages remain ordinary Markdown files. Folio presents them as an editorial transcript by default and offers an explicit Edit mode. Participant indicators survive read, edit, save, external editing, and repeated capture.

## Goals

- Capture the visible user/assistant conversation through Clepsydra MCP in one request.
- Preserve turn order and participant identity in portable Markdown.
- Add a visually distinct, Folio-native transcript presentation.
- Support a polished Read mode and explicit rich Edit mode.
- Create once and append safely when a provider exposes a stable host conversation ID.
- Preserve local edits and reject ambiguous or divergent appends rather than guessing.

## Non-goals

- Clepsydra retrieving history directly from ChatGPT or Claude.
- Capturing hidden system/developer prompts, tool traces, attachments, or provider-only metadata.
- Fuzzy conversation matching.
- Bidirectional synchronization to the source chat.
- Automatic summarization.

## Existing architectural fit

The page kind vocabulary is a closed backend enum in `src/vault/kind.rs`. A kind selects a canonical folder and frontend presentation; ADR 0001 explicitly defines kind as the frontend renderer selector. Frontend types derive from the backend OpenAPI schema, and `ui/src/lib/kindPresentation.tsx` already specializes Journal Folios.

The MCP server already creates atomic pages containing a declared kind and Markdown body. The new feature extends those patterns rather than adding a second storage system.

## Page kind and filing

Add backend kind:

- Rust variant: `Kind::AiConversation`
- wire/frontmatter token: `AI_CONVERSATION`
- canonical folder: `conversations/`
- inferred folder names: `conversations`, `conversation`, and `chats`
- frontend label: `AI CONVERSATION`

Regenerate OpenAPI so the frontend `Kind` union remains backend-authoritative. Add the kind to frontend display order, metadata, folder inference, filters, and all exhaustive kind tests.

Conversation identity and append state are typed frontmatter metadata:

```toml
type = "AI_CONVERSATION"

[conversation]
provider = "claude"
host_id_hash = "sha256:..."
captured_turn_count = 12
captured_prefix_hash = "sha256:..."
last_source_identity = "sha256:..."
```

`conversation.provider` is optional when no host conversation ID is supplied. A host conversation ID requires a provider because identity is namespaced by `(provider, host_id_hash)`. The API hashes the provider-owned ID before lookup and never persists the raw ID. The exact hashed identity is indexed for lookup. The capture cursor, turn count, and cumulative prefix hash form an API-owned ledger independent of the editable body.

## Canonical Markdown representation

Each turn is stored as a standard Markdown blockquote callout with a machine-readable marker:

```markdown
> [!AI-USER source="source-identity"]
>
> How should this work?

> [!AI-ASSISTANT source="source-identity"]
>
> Use a structured MCP capture contract.
```

The marker carries:

- role: `user` or `assistant`, encoded in the marker token;
- a stable source identity derived from the host turn ID when available, otherwise from the exact original role/content;
- an immutable source sequence for captured turns;
- optional timestamp metadata when the host exposes it.

Raw provider turn IDs need not be displayed. The representation must safely encode arbitrary source identifiers and must preserve duplicate identical turns by sequence position. Locally inserted turns use a separate Clepsydra-local identity namespace and are excluded from the capture ledger.

Blockquotes keep the file readable in external Markdown editors and allow turn contents to contain ordinary Markdown, including headings, lists, code fences, math, links, and wikilinks.

The Markdown-to-Slate and Slate-to-Markdown converters recognize and emit this form as a `conversation-turn` block element. Read → Edit → Save must preserve turn boundaries, roles, source identities, and nested content.

Unknown or malformed markers never cause content loss. Folio renders the affected region as ordinary Markdown, reports a non-destructive warning, and offers Edit mode for repair.

## Capture API

Add an API-owned atomic operation:

`POST /api/vault/conversations/capture`

The API, not the MCP process, owns matching, validation, deduplication, revision handling, and mutation so concurrent requests cannot produce partial or duplicate updates.

Request model:

```text
title: string
provider?: string
host_conversation_id?: string
turns: Array<{
  role: "user" | "assistant"
  content: string
  source_turn_id?: string
  timestamp?: string
}>
```

The title is required at the API boundary. The calling model may synthesize it unless the user supplies one. Provider is a normalized, future-compatible token rather than a closed ChatGPT/Claude enum.

Response model:

```text
path: string
page_id: string
operation: "created" | "appended" | "unchanged"
appended_turns: number
skipped_turns: number
warnings: string[]
```

## MCP affordance

Add `vault_capture_conversation` with the same structured request fields. Its tool description instructs the calling model to:

1. include only visible user and assistant turns;
2. send turns in source order;
3. send the complete visible transcript rather than a prose summary;
4. provide provider and host conversation ID when the MCP host exposes them;
5. synthesize a concise title when the user does not specify one.

The MCP handler forwards to the capture API and renders the structured result or conflict. Generic `vault_create_page` remains supported but is not the recommended conversation capture path because model-invented Markdown cannot guarantee stable turn structure or append semantics.

Clepsydra cannot independently read host chat history. Context omitted or truncated by the host cannot be captured. Hidden prompts and provider metadata are not inferred.

## Create and append semantics

### Create

When no host conversation ID is supplied, every capture creates a new conversation Folio. Clepsydra does not fingerprint whole conversations to select a write target.

When the hash of `(provider, host_conversation_id)` has no match, capture creates one page atomically with all validated turns and typed conversation metadata; the raw host ID is not stored.

### Append

When the exact identity has one match, capture verifies the complete submitted source prefix against the API-owned capture ledger:

- the same turn count and cumulative prefix hash is `unchanged`;
- a valid existing prefix plus unseen suffix appends only the suffix and advances the ledger atomically;
- missing earlier context, divergence, reordering, conflicting reuse of a source turn ID, or a prefix-hash mismatch returns a conflict and writes nothing.

The ledger is not recomputed from the editable body. Local edits, correction, reordering, insertion, or deletion therefore do not cause a later capture to duplicate or overwrite locally managed turns. Newly captured source turns append at the end of the document.

When the identity has multiple matches, capture returns a conflict and writes nothing. Clepsydra never chooses by title, content similarity, recency, or path.

All validation and mutation are all-or-nothing. The API rejects an empty transcript, any turn with empty content, malformed source metadata, stale revisions, or identity conflicts without leaving a partial page or append.

## Folio interaction

### Default Read mode

An `AI_CONVERSATION` Folio opens in Read mode. A `READ / EDIT` toggle appears in the document header; mode is local UI state and is not written to the page.

The approved editorial transcript treatment uses:

- participant and optional timestamp in the margin;
- neutral Folio prose for user turns;
- a restrained provider-coloured left rule for assistant turns;
- the existing Folio prose measure and typography for long-form content;
- no bubbles or source-chat chrome.

The user participant label defaults to `You`. The assistant label uses the page provider when known (`Claude`, `ChatGPT`) and otherwise `Assistant`.

On narrow screens, margin metadata collapses above the turn content without changing turn order or semantics.

### Edit mode

Edit mode uses Slate with a registered `conversation-turn` block element. It keeps a compact role/provider indicator while exposing the turn body through the normal rich Markdown editor.

The user can:

- edit turn content;
- correct a role;
- insert a turn;
- reorder turns;
- remove a turn.

A locally inserted turn receives a Clepsydra-local identity and is never mistaken for a later source-captured turn. Structural normalization keeps valid conversation turn boundaries without deleting unknown content.

## Compatibility

- Existing pages and `vault_create_page` behavior do not change.
- Search, list, kind filtering, assignment, folder projection, backlinks, encryption, sync, and archive behavior treat `AI_CONVERSATION` as a normal kind.
- A manually assigned or generically created conversation page may lack valid turn markers. It remains visible as ordinary Markdown and can be repaired in Edit mode.
- External editors retain a readable standard-Markdown representation.
- Assigning a different kind does not destroy turn markers; it only returns the page to the generic Folio presentation.

## Failure handling

- Exact hashed provider/conversation identity only; no fuzzy matching and no persisted raw host conversation ID.
- Conversation ID without provider is rejected.
- Concurrent captures use the existing revision/conflict machinery.
- A source turn ID reused with conflicting role/content is a hard conflict.
- Malformed turn syntax preserves content and surfaces a warning.
- Capture errors return actionable conflict details without leaking hidden host context.

## Verification

### Backend

- kind token, canonical folder, folder inference, serialization, and OpenAPI coverage;
- atomic create;
- idempotent recapture;
- suffix append with complete-prefix verification;
- locally edited turn preservation;
- duplicate identical turn ordering;
- divergent transcript, duplicate identity, multiple-page identity, stale revision, and concurrent capture conflicts;
- no artifact or partial append after failure.

### MCP

- tool schema and discoverability;
- payload forwarding and response rendering;
- provider/identity validation;
- created, appended, unchanged, and conflict results.

### Markdown/editor

- user/assistant marker parsing and serialization;
- nested headings, lists, blockquotes, code fences, math, links, and wikilinks;
- optional timestamp and source metadata;
- malformed marker fallback;
- read/edit/save round-trip stability;
- local insertion, role correction, reorder, and removal.

### UI

- default Read mode and local mode toggle;
- editorial participant treatment and provider labels;
- responsive margin collapse;
- warning and repair affordance for malformed content;
- manually assigned unstructured page fallback;
- encrypted and locked conversation behavior.

### End-to-end smoke

Invoke `vault_capture_conversation`, invoke it again with one additional turn, open the resulting Folio, verify participant presentation, toggle Edit, modify and save a turn, re-capture, and confirm the local edit remains and no turn is duplicated.

## Documentation

Update MCP tool documentation and the in-app user documentation with:

- the natural-language capture instruction;
- what content is and is not available to Clepsydra;
- create/append identity behavior;
- conflict recovery;
- Read/Edit mode behavior;
- the portable Markdown representation.
