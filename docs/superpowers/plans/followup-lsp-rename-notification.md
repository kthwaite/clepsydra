# Follow-up: emit LSP file-rename notification on reconcile move

**Status:** backlog (logged 2026-06-01 during §7 Plan 3 Task 5)

## Problem

`did_save` reconcile moves a file on disk (page relocated to follow its declared
kind/project) but emits no `workspace/didRenameFiles` / `workspace/applyEdit`.
An editor with the old URI open is left stale — it still points at the pre-move
path. For v1 the backend only sends a `show_message`/`log_message` INFO line so
the move is at least non-silent.

## Proposed

On a detected move, send the appropriate rename/applyEdit (e.g.
`workspace/applyEdit` with a `RenameFile` resource op, or a
`workspace/didRenameFiles` notification) so the client retargets the open buffer
to the new URI automatically.

## Acceptance

Saving a page that relocates updates the open buffer's URI without a manual
reopen.

## Related: LSP does not broadcast `change_tx` (frontend SSE)

Separately, `did_save` never sends a `SyncNotification` on the `change_tx`
channel — not for ordinary edits and not for reconcile moves — so a web
frontend's query cache is not invalidated by LSP-driven changes. The assign
endpoint and the serve-startup sweep both broadcast on a move; the LSP trigger
is the asymmetric one. This is a pre-existing LSP→frontend gap (the LSP has
always been silent toward the HTTP/SSE layer), not introduced by Plan 3. If/when
the LSP is wired to broadcast frontend invalidations, include the
`removed`/`upserted` paths of a reconcile move so all three triggers stay
symmetric.
