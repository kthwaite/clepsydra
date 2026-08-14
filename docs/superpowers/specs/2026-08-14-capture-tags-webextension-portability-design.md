# Capture Tags and WebExtension Portability Design

**Status:** Proposed for implementation
**Date:** 2026-08-14

## Summary

Allow people to add per-capture tags in the browser-extension popup and to edit ordinary tags later on archived Folios. Configured extension defaults remain static: each capture receives the defaults plus that capture's additions, while popup edits never alter settings.

At the same time, remove direct production reads of the `chrome` global. One local compatibility module will select `globalThis.browser` when available and otherwise `globalThis.chrome`, exposing the selected WebExtension API to application code without mutating either global. Chromium and Firefox remain the only packaged and verified distribution targets in this change; Safari packaging, signing, entitlements, and release support are explicitly separate work.

## Goals

- Let the extension popup add tags to one capture without changing configured defaults.
- Keep configured default tags visible and immutable in the popup.
- Preserve per-capture additions across popup closure and MV3 service-worker suspension.
- Combine system, default, and per-capture tags deterministically without duplicates.
- Let archived Folios add and remove ordinary tags without unlocking or rewriting the captured body.
- Keep computed tags immutable.
- Remove direct production dependence on a `chrome` global.
- Normalize the small set of callback/Promise differences used by this extension at one compatibility boundary.
- Preserve MV3 Chromium and MV2 Firefox behavior, including optional-API fallbacks.

## Non-goals

- Changing configured default tags from the popup.
- Making the archive body, title, aliases, provenance, snapshot, or CAS resources editable.
- Adding tags to toolbar-button or keyboard-shortcut captures; those entry points continue with system and configured default tags only.
- Changing tag case, introducing a tag taxonomy, or adding tag validation beyond existing vault rules.
- Adding Safari app-extension conversion, an Xcode project, signing, entitlements, packaging, CI, or a Safari support claim.
- Changing the archive API schema or page-update endpoint.
- Retrofitting historical archive pages with new tags.

## Tag semantics

A capture's submitted tag list is the ordered union of:

1. system tags: `archive`, the captured domain, and the current `YYYY-MM` capture month;
2. configured `default_tags`; and
3. popup-supplied per-capture additions.

Normalization trims surrounding whitespace, removes one optional leading `#`, drops empty values, and removes exact duplicates while preserving the first occurrence and original case. It does not case-fold or rewrite punctuation. This normalization is shared by the popup and worker, with the worker authoritative because messages and restored session state are untrusted inputs.

Defaults are immutable only at capture time: the popup cannot remove or replace them and never writes `storage.sync`. After the page is archived, all non-computed frontmatter tags—including former system and default tags—are ordinary tags and may be added or removed through the Folio editor. Computed tags remain visible but non-editable.

## Extension API compatibility boundary

Add a local `webext` module that reads the optional `browser` and `chrome` properties from `globalThis`, prefers `browser`, falls back to `chrome`, and throws one explicit initialization error when neither provides `runtime`. Production modules import the selected API rather than reading either global directly.

Do not use `webextension-polyfill`: its current bootstrap requires `globalThis.chrome.runtime.id` before it checks for a native `browser` namespace, so a browser-only host would fail at import time—the exact coupling this change removes. The project already targets modern Promise-capable Chromium MV3 APIs and native Promise-based Firefox MV2 APIs; a small local boundary is narrower and preserves browser-only initialization.

The migration covers background worker, popup, options, content capture, script injection, relay fetch, storage, tabs, runtime messaging and ports, toolbar actions, commands, and notifications. Type-only `chrome` namespace references may remain because they are erased from emitted JavaScript; production values must come from `webext`. A minimal ambient declaration describes an optional `globalThis.browser` with the compatible API shape.

The boundary exports the selected raw API plus focused Promise adapters only for calls where the current extension still depends on callback-era behavior, principally active-tab lookup and MV2 script injection. It does not create wrappers around APIs that already share the Promise contract used by this code. Existing semantic adaptation remains for:

- MV3 `action` versus MV2 `browserAction`;
- MV3 `scripting.executeScript` versus MV2 `tabs.executeScript`;
- optional `storage.session`;
- optional notifications and toolbar badge methods; and
- APIs whose absence must produce an actionable capture error rather than an import-time crash.

Optional APIs are capability-checked at the use site after obtaining the common API object. Notification, badge, and session-storage absence remains non-fatal. Missing injection, tab, runtime messaging, or sync-storage capabilities fail the affected action with the existing user-visible error path.

Bundle verification will load each produced worker in two independent harnesses: one exposing only a Chromium-style `chrome` namespace and one exposing only a native-style `browser` namespace. Both must register the expected listeners without DOM access. This proves namespace selection and bundle initialization; it does not constitute Safari runtime certification.

References:

- MDN, WebExtension API namespaces and Chrome incompatibilities: <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities>
- Apple, assessing Safari Web Extension compatibility: <https://developer.apple.com/documentation/safariservices/assessing-your-safari-web-extension-s-browser-compatibility>

## Popup design

The compact popup adds a tag section before the capture button:

- `Defaults` displays configured default tags as non-interactive chips or a clear empty state.
- `Additional tags` is a labelled text input using comma-separated values, matching the extension's existing settings convention.
- Supporting text states that additions apply only to this capture.

The tag input remains editable while idle or in a terminal state and is disabled while the selected tab has an active capture. Reopening the popup during an active capture displays the additions retained with that attempt but does not permit changing them. Reopening after a terminal result starts with an empty additions draft; defaults are loaded again from `storage.sync`.

The popup installs its button, unload, and input handlers synchronously before awaiting storage, tab, worker rehydration, or reachability. A capture can therefore still start if settings display loading is delayed: the worker independently loads authoritative defaults, and the popup sends only the current additional-tag draft.

Submitting Capture sends:

```ts
{
  type: "capture_start";
  tabId: number;
  additionalTags: string[];
}
```

Status responses include the normalized `additionalTags` owned by that attempt so popup reopen can render the immutable in-flight selection. Existing phase, detail, attempt identity, and timestamps remain unchanged.

## Worker ownership and persistence

`CaptureStatus` gains `additionalTags: string[]`. Attempt claiming accepts additions only when creating a new attempt. A duplicate start for an already-active tab returns the existing status and cannot replace that attempt's tags.

Statuses already persist under `captureStatuses` in `storage.session`; additions are stored in the same status record and therefore share its ordering, stale-write protection, tab cleanup, and restart repair behavior. Rehydration validates additions as an array of strings and normalizes them. Legacy status records without the field rehydrate with an empty array.

When the content script's `capture_meta` binds a capture ID to the current tab attempt, the binding retains that attempt's additions. Transfer completion passes those additions to `processCapture`. The worker reloads configured defaults at processing time, computes the ordered normalized union, and sends it in the existing archive manifest.

Captures started by toolbar action or keyboard command claim attempts with `additionalTags: []`. Content scripts remain page-extraction code and do not receive or own tag state.

Terminal status retention may include the additions for diagnostics and popup continuity. A subsequent new attempt replaces them. Tab removal clears them with the status. Interrupted processing/uploading attempts retain their tags only as part of the repaired terminal error record; retry starts a fresh attempt from the popup's current draft.

## Archived Folio editing

Archive bodies remain protected through `editor.readonly`. The archive presentation continues to use `ReadOnlyPageHeader` for title, aliases, provenance, and live/snapshot navigation, but that header gains an optional ordinary-tag editing control.

`Folio` enables this control only when the page is a body-protected archive with archive metadata. Conversation and recipe read modes do not gain tag editing merely because they are displayed read-only. The control receives:

- editable ordinary tags;
- immutable computed tags;
- existing debounced tag suggestions and their loading/error/retry state;
- `editor.setTags` and `editor.saveNow`; and
- current save, conflict, and disabled state.

The editor reuses the existing `TagInput` interaction and visual vocabulary instead of introducing a second tag editor. Add/remove operations update only `tags`; `usePageEditor` already emits a revision-checked request containing changed metadata and omits unchanged body bytes. The server's page update path permits metadata-only updates on protected pages, so archive hashes, body content, snapshots, and CAS references remain unchanged.

A tag blur/commit follows existing Folio save behavior. Revision conflict blocks further local saves until reload, preserving the user's visible draft and existing conflict controls. Network or validation failure appears through the existing save indicator/error path. Computed tags are rendered separately and cannot be removed.

## Data and API contracts

No Rust request or response shape changes are required:

- archive ingest already accepts `tags: string[]`;
- page detail already returns ordinary and computed tags; and
- page update already accepts optional `tags` plus `expected_revision`, and permits metadata-only changes while the body is protected.

The generated OpenAPI client remains unchanged unless implementation reveals a contract mismatch. Such a mismatch upgrades this design before code proceeds; it must not be patched with an untyped request.

The extension message/status contract changes internally and is validated at the worker boundary. Unknown fields remain ignored. Malformed `additionalTags` fail closed to an empty list rather than aborting capture; valid strings are normalized authoritatively.

## Error handling

- Failure to load defaults for popup display shows an inline tag-settings diagnostic but does not prevent capture; the worker's existing settings fallback remains authoritative.
- Missing optional notification, badge, or session APIs cannot change capture success.
- Failure to persist session status leaves the current in-memory capture functional, matching existing behavior; popup reopen after suspension may lose additions only when the platform's session API itself is unavailable or failing.
- Missing required runtime, tabs, scripting, or sync-storage capabilities produces an actionable capture/start error through existing status UI.
- Malformed tag message data becomes no additions, never arbitrary manifest data.
- Archive tag save failures preserve the draft and expose retry/conflict behavior through the existing Folio editor state.

## Testing

### Extension unit tests

- Popup renders immutable defaults and an empty additions input.
- Popup normalizes additions and sends them in `capture_start` without writing settings.
- Active status restores and disables the retained additions.
- Terminal status permits a fresh empty additions draft.
- Delayed or failed settings display does not make the Capture button inert.
- Worker combines system, default, and additional tags in stable first-occurrence order.
- Worker ignores malformed additions and exact-deduplicates overlaps.
- Duplicate starts cannot replace active-attempt additions.
- Session rehydration retains additions; legacy records default to none.
- Worker restart between start and `capture_meta` still applies additions.
- Toolbar and keyboard starts use no additions.
- Existing optional-notification failure cases remain successful.

### Compatibility and bundle tests

- Compatibility module resolves a native `browser` namespace without reading `chrome`.
- It falls back to `chrome` when `browser` is absent.
- Absence of both namespaces fails with one explicit initialization error.
- Chromium and Firefox production worker bundles initialize in chrome-only and browser-only harnesses and register the expected listeners.
- Existing MV3 scripting/action and MV2 executeScript/browserAction tests remain green.

### UI tests

- An archived Folio renders ordinary and computed tags while keeping title/body read-only.
- Ordinary archive tags can be added and removed through named accessible controls.
- Computed tags cannot be removed.
- The update request contains `expected_revision` and `tags` but no body when only tags changed.
- Save error preserves the draft; revision conflict exposes reload behavior.
- Conversation/recipe read presentations do not accidentally gain archive tag controls.
- Ordinary editable Folio tag behavior remains unchanged.

### Runtime verification

Build and load the Chromium extension unpacked against the running server. Capture a fixture with overlapping defaults and additions, then verify the stored archive contains the expected ordered deduplicated tags. Close/reopen the popup during a deliberately delayed capture and verify additions remain visible and immutable. Open the archived Folio, add and remove ordinary tags, reload it, and verify the body, archive hashes, snapshot link, and computed tags are unchanged.

Firefox output receives build and bundle verification. If a runnable Firefox extension environment is available, repeat the capture smoke test there; otherwise report that runtime Firefox interaction was not performed. Safari runtime and packaging are out of scope and must not be claimed.

## Documentation

Update the browser-extension guide to explain default versus per-capture tags and the supported namespace/build matrix. Update the capture/archive guide to explain that archive bodies remain protected while ordinary tags are amendable. Do not imply Safari packaging or support.

## Delivery

Implement from a TDD task plan in the isolated `feature/capture-tags-webext` worktree. Use independently reviewed tasks for the compatibility migration, capture-time tags, archive Folio editing, documentation, and runtime verification. Run extension typecheck, lint, full tests, Chromium build and Firefox build; UI typecheck, lint, full tests and production build; Rust formatting, Clippy, and the full Rust test suite. Review the complete branch, merge it into `develop` from an integration worktree if the primary checkout contains unrelated work, then remove feature/integration worktrees and the merged branch.
