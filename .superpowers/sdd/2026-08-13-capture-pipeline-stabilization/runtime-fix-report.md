# Runtime Capture Blocker Diagnosis

## Status

Diagnosed. No source fix was applied because the blocker predates Tasks 3 and 4 and occurs before either task's changed behavior is reached.

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

## Scope decision

Per the instruction to fix only a Task-3/4-caused regression, no production source or test was changed. A correct fix belongs to the earlier SingleFile integration boundary and requires an explicit design choice:

- provide the upstream-compatible worker routing/timer handlers for SingleFile runtime messages; or
- force the standalone core to use its same-window `MessageChannel` and native timer paths rather than extension-runtime messaging.

Either changes behavior outside snapshot transfer and relay-fetch stabilization. Implementing one here would silently widen Task 4 and could create a second SingleFile integration convention.

## Verification impact

Task 4's source-level and bundle gates remain green from its reports, but end-to-end capture is blocked by this pre-existing SingleFile boundary. Real-browser archive verification cannot proceed until that boundary is repaired in the owning task.

## Commit

This diagnosis is committed separately; see the commit reported to the parent agent.
