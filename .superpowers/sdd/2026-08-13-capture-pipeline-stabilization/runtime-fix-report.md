# Runtime Capture Blocker Diagnosis

## Status

Implemented after the stabilization scope was explicitly extended to cover this pre-existing SingleFile integration blocker.

## Reproduction evidence

Runtime verification in Chrome 148 loaded the built extension and triggered capture on plain, framed, authenticated, and >4 MiB fixture pages. In every case:

- the popup closed after the trusted click;
- capture phase remained `null`, the badge remained empty, and no archive request appeared after 30–180 seconds;
- the extension worker received `capture_status`, then a message shaped as `{ method: "singlefile.frameTree.initResponse", frames: [], sessionId: ... }` from the target tab;
- no `capture_meta`, `capture_error`, or `singlefile-relay` port followed.

The absence of a relay port is decisive: Task 4's fallback transport has not been entered. `single-file-core` is still in its frame-tree pre-initialisation inside `captureSnapshot`.

## Root cause

`single-file-core/processors/frame-tree/content/content-frame-tree.js` has two response paths in `sendInitResponse`:

1. call `top.singlefile.processors.frameTree.initResponse(message)` when the upstream SingleFile extension global exists;
2. on failure, call `sendMessage(top, message, true)`.

Its `sendMessage` chooses `browser.runtime.sendMessage(message)` whenever `globalThis.browser.runtime.sendMessage` exists. In this extension runtime that branch is active, as proved by Chrome observing the `singlefile.frameTree.initResponse` message at the service worker.

The service worker has no upstream SingleFile frame-tree router. It neither forwards `singlefile.frameTree.initResponse` back to the initiating tab nor implements SingleFile's lazy-timeout messages. The top-frame `getAsync()` session therefore never receives its own empty-frame response, its promise never resolves, and `captureSnapshot` remains pending before resource fetching or capture transfer begins.

For a plain page, the dependency's exact sequence is:

- `getPageData` starts `processors.frameTree.getAsync(options)`;
- `getAsync` creates a session promise and invokes `processFrames`;
- `processFramesAsync` calls `sendInitResponse({ frames: [], sessionId })` even when there are no frames;
- runtime messaging sends that response to the worker;
- the worker ignores the message because it has no typed capture `type`;
- the frame session's resolver is never called.

This explains why the same blocker appears on the plain fixture and why neither a relay port nor capture metadata is observable.

## Task 3/4 causality check

Command:

```text
git diff --quiet f00377e8^ HEAD -- extension/src/lib/inject-capture.ts extension/src/lib/singlefile.ts extension/src/content/frames.ts
```

Result: exit 0. Tasks 3 and 4 did not change capture injection, the SingleFile boundary, or frame responder code.

The pre-Task-3 `extension/src/content/capture.ts` at `f00377e8^` already executed the same boundary:

```text
const relayFetch = createRelayFetch(send);
const snapshotHtml = await captureSnapshot(
  { maxResourceSizeMb: await maxResourceSizeMb() },
  { fetch: relayFetch, frameFetch: relayFetch },
);
```

Task 3 changed only snapshot transfer after `captureSnapshot` resolves. Runtime never reaches that point.

Task 4 changed the injected fetch function's fallback implementation from `sendMessage` to a runtime port. Runtime never calls that function: no `singlefile-relay` connection is observed, and the pending frame-tree promise precedes SingleFile resource fetching.

The frame responder/injection files originate in earlier commits (`30577883 feat(extension): inject the frame responder so iframes are captured` and `fb20cff8 feat(archive): fix capture pipeline, harden blob serving, declare ARCHIVE kind`), outside Task 3/4 ownership.

## Initial scope decision

Per the instruction to fix only a Task-3/4-caused regression, no production source or test was changed. A correct fix belongs to the earlier SingleFile integration boundary and requires an explicit design choice:

- provide the upstream-compatible worker routing/timer handlers for SingleFile runtime messages; or
- force the standalone core to use its same-window `MessageChannel` and native timer paths rather than extension-runtime messaging.

Either changes behavior outside snapshot transfer and relay-fetch stabilization. Implementing one here would silently widen Task 4 and could create a second SingleFile integration convention.

## Initial verification impact

Task 4's source-level and bundle gates remain green from its reports, but end-to-end capture is blocked by this pre-existing SingleFile boundary. Real-browser archive verification cannot proceed until that boundary is repaired in the owning task.

## Commit

This diagnosis is committed separately; see the commit reported to the parent agent.

## Scope extension and implementation

The stabilization exit gate was subsequently extended to include real-browser success, so the upstream-compatible worker integration was implemented.

### Upstream reference

SingleFile's background implementation at `src/lib/single-file/frame-tree/bg/frame-tree.js` handles exactly two frame methods:

- `singlefile.frameTree.initResponse`
- `singlefile.frameTree.ackInitRequest`

It forwards both messages to `sender.tab.id` with `{ frameId: 0 }` and returns a resolved response to the originating runtime message.

SingleFile's `src/lib/single-file/lazy/bg/lazy-timeout.js` owns per-tab, per-frame, per-type timers for:

- `singlefile.lazyTimeout.setTimeout`
- `singlefile.lazyTimeout.clearTimeout`

When a timer expires it sends `singlefile.lazyTimeout.onTimeout` to the tab. Replacing a timer clears its predecessor, and tab removal drops the tab's timer state.

The implemented `SingleFileRuntime` follows those upstream boundaries rather than forcing the dependency down its private same-window fallback.

### RED evidence

Command:

```text
bun run test -- lib/__tests__/singlefile-runtime.test.ts
```

Result before implementation: **FAILED** during collection because `#/lib/singlefile-runtime` did not exist. The absent boundary represented the runtime-observed hang: no component claimed and forwarded the frame session's init response.

### Implementation

- Added `extension/src/lib/singlefile-runtime.ts`.
  - Routes validated frame init responses and request acknowledgements back to the top frame.
  - Returns a resolved empty response so `single-file-core` knows its runtime message was handled.
  - Implements validated, bounded lazy set/clear messages with per-tab/per-frame/per-type timer replacement.
  - Sends the upstream `lazyTimeout.onTimeout` response and releases empty timer maps.
  - Clears every live timer and its state when the source tab closes.
  - Ignores unrelated or malformed messages so existing capture messages retain their current listener path.
- Integrated the router at the start of the service worker's existing `onMessage` listener and added tab-removal cleanup.
- Added focused tests for empty frame init-response routing (the observed plain-page hang), frame acknowledgements, lazy expiry, lazy cancellation, timer replacement, tab cleanup, and malformed/unrelated messages.

### GREEN evidence

Focused SingleFile runtime and relay tests:

```text
bun run test -- lib/__tests__/singlefile-runtime.test.ts lib/__tests__/relay-fetch.test.ts
```

Result: **PASS** — 2 files, 27 tests passed, 0 failed.

Full extension tests:

```text
bun run test
```

Result: **PASS** — 13 files, 131 tests passed, 0 failed.

Typecheck:

```text
bun run typecheck
```

Result: **PASS** — `tsc --noEmit` completed without diagnostics.

Lint:

```text
bun run lint
```

Result: **PASS** — Biome checked 35 source files with no fixes or diagnostics.

Chromium build:

```text
bun run build
```

Result: **PASS** — all entry points built and the DOM-free verifier loaded the worker with its 5 expected listener registrations.

Firefox build:

```text
bun run build:firefox
```

Result: **PASS** — all Firefox-targeted entry points built and the verifier loaded the worker with its 5 expected listener registrations.

### Self-review

- The empty-frame regression exercises the actual missing worker boundary using the exact observed method, empty `frames`, session ID, sender tab, and top-frame destination. Removing the router or moving it after typed capture dispatch makes the session response unhandled again.
- The implementation does not emulate frame sessions itself; it only restores the upstream message routing so the content-side session remains the sole owner of resolution.
- Lazy timeout behavior matches the upstream ownership model and avoids accumulated timers by replacing identical keys and clearing all handles on tab removal.
- Frame and lazy message validation prevents unrelated runtime traffic from being claimed. Existing capture status, metadata, chunks, aborts, errors, and Task 4 relay ports keep their current paths.
- Task 4 direct/worker fetch options, pull/ack framing, 4 MiB raw bound, disconnect cleanup, and final URL behavior are untouched.

### Runtime verification handoff

The production bundles are ready for `RuntimeVerificationImplementer` to rerun the original Chrome fixture matrix against this commit.
