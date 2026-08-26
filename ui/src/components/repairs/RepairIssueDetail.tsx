import { useRef, useState } from "react";
import {
  type ReferenceIssue,
  ReferenceRepairApiError,
  type ReferenceRepairPreview,
  type ReferenceRepairRequest,
  useApplyReferenceRepair,
  usePreviewReferenceRepair,
} from "#/api/index";
import { Button } from "#/components/ui/button";
import { TextField } from "#/components/ui/text-field";
import { useOpenTab } from "#/hooks/useOpenTab";
import { issueLabel } from "./RepairIssueList";

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export interface RepairIssueDetailProps {
  issue: ReferenceIssue;
  onRefresh: () => Promise<unknown> | unknown;
  onApplied: () => void;
}

export function RepairIssueDetail({
  issue,
  onRefresh,
  onApplied,
}: RepairIssueDetailProps) {
  const openTab = useOpenTab();
  const previewMutation = usePreviewReferenceRepair();
  const applyMutation = useApplyReferenceRepair();
  const [preview, setPreview] = useState<ReferenceRepairPreview | null>(null);
  const [previewRequest, setPreviewRequest] =
    useState<ReferenceRepairRequest | null>(null);
  const [folder, setFolder] = useState("");
  const [body, setBody] = useState("");
  const [alert, setAlert] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const previewSequence = useRef(0);


  const canRepair = issue.actions.some(
    (action) => action === "replace" || action === "create",
  );

  function invalidatePreview() {
    previewSequence.current += 1;
    setPreview(null);
    setPreviewRequest(null);
    setStatus(null);
  }

  async function refreshStaleIssue() {
    setPreview(null);
    setPreviewRequest(null);
    await onRefresh();
    setAlert(
      "This issue changed since it was loaded. The issue list was refreshed.",
    );
  }

  async function previewRepair(request: ReferenceRepairRequest) {
    const sequence = previewSequence.current + 1;
    previewSequence.current = sequence;
    setPreview(null);
    setPreviewRequest(null);
    setAlert(null);
    setStatus("Preparing repair preview…");
    try {
      const result = await previewMutation.mutateAsync(request);
      if (previewSequence.current !== sequence) return;
      setPreview(result);
      setPreviewRequest(request);
      setStatus("Repair preview ready. Review the before and after evidence.");
    } catch (error) {
      if (previewSequence.current !== sequence) return;
      setStatus(null);
      if (error instanceof ReferenceRepairApiError && error.status === 409) {
        await refreshStaleIssue();
        return;
      }
      setAlert(errorText(error, "Repair preview could not be prepared."));
    }
  }

  async function applyRepair() {
    if (!previewRequest) return;
    setAlert(null);
    setStatus("Applying previewed repair…");
    try {
      await applyMutation.mutateAsync(previewRequest);
      setStatus("Repair applied. Waiting for the refreshed issue list.");
      onApplied();
    } catch (error) {
      setStatus(null);
      if (error instanceof ReferenceRepairApiError && error.status === 409) {
        await refreshStaleIssue();
        return;
      }
      setAlert(errorText(error, "Repair could not be applied."));
    }
  }

  return (
    <div className="space-y-4">
      <header className="border-b border-rule pb-3">
        <p className="cl-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute">
          {issue.kind.replaceAll("_", " ")}
        </p>
        <h2 className="mt-1 break-words text-lg font-bold text-ink">
          {issueLabel(issue)}
        </h2>
        <p className="mt-1 break-all text-xs text-ink-mute">
          {issue.source_path}
          {issue.source_field ? ` · ${issue.source_field}` : ""}
        </p>
      </header>

      <section aria-labelledby="repair-evidence-heading">
        <div className="flex items-center justify-between gap-3">
          <h3
            id="repair-evidence-heading"
            className="cl-mono text-[10px] font-bold uppercase tracking-[0.15em] text-ink"
          >
            Source evidence
          </h3>
          {issue.actions.includes("open_source") ? (
            <Button
              size="sm"
              variant="ghost"
              onPress={() =>
                openTab(
                  "page",
                  issue.source_path,
                  issue.source_title ?? issue.source_path,
                )
              }
            >
              Open source
            </Button>
          ) : null}
        </div>
        {issue.snippet ? (
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap border-l-2 border-cool bg-paper-2 px-3 py-2 font-mono text-xs leading-relaxed text-ink-2">
            {issue.snippet}
          </pre>
        ) : issue.kind === "orphan_page" ? (
          <p className="mt-2 border-l-2 border-rule px-3 py-2 text-sm text-ink-mute">
            This page has no incoming references. Open the source to decide
            whether it should be linked, moved, or removed.
          </p>
        ) : issue.kind === "isolated_page" ? (
          <p className="mt-2 border-l-2 border-rule px-3 py-2 text-sm text-ink-mute">
            This page has no incoming or outgoing references. Open the source to
            reconnect it to the vault.
          </p>
        ) : (
          <p className="mt-2 border-l-2 border-rule px-3 py-2 text-sm text-ink-mute">
            Source text is unavailable or redacted. Open the source to inspect
            the reference.
          </p>
        )}
      </section>

      {canRepair ? (
        <section aria-labelledby="repair-actions-heading" className="space-y-3">
          <h3
            id="repair-actions-heading"
            className="cl-mono text-[10px] font-bold uppercase tracking-[0.15em] text-ink"
          >
            Repair action
          </h3>

          {issue.actions.includes("replace") && issue.candidates.length > 0 ? (
            <div className="space-y-2">
              {issue.candidates.map((candidate) => (
                <div
                  key={candidate.page_id}
                  className="flex items-start justify-between gap-3 border-t border-rule pt-2"
                >
                  <div className="min-w-0">
                    <p className="break-all text-sm font-medium text-ink">
                      {candidate.title || candidate.path}
                    </p>
                    <p className="mt-1 break-all text-xs text-ink-mute">
                      {candidate.path} · {candidate.rationale}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    onPress={() =>
                      void previewRepair({
                        fingerprint: issue.fingerprint,
                        source_revision: issue.source_revision,
                        action: {
                          type: "replace",
                          candidate_page_id: candidate.page_id,
                        },
                      })
                    }
                    isDisabled={
                      previewMutation.isPending || applyMutation.isPending
                    }
                    aria-label={`Replace with ${candidate.path}`}
                  >
                    Preview
                  </Button>
                </div>
              ))}
            </div>
          ) : null}

          {issue.actions.includes("create") ? (
            <div className="space-y-3 border-t border-rule pt-3">
              <TextField
                label="New page folder"
                value={folder}
                onChange={(value) => {
                  setFolder(value);
                  invalidatePreview();
                }}
                placeholder="Vault root"
              />
              <label className="block text-xs font-bold uppercase tracking-widest text-ink-mute">
                Initial body
                <textarea
                  value={body}
                  onChange={(event) => {
                    setBody(event.target.value);
                    invalidatePreview();
                  }}
                  rows={4}
                  className="mt-2 block w-full resize-y border border-input bg-paper px-3 py-2 text-sm font-normal normal-case tracking-normal text-ink outline-none focus:border-ring"
                />
              </label>
              <Button
                size="sm"
                onPress={() =>
                  void previewRepair({
                    fingerprint: issue.fingerprint,
                    source_revision: issue.source_revision,
                    action: { type: "create", folder: folder.trim(), body },
                  })
                }
                isDisabled={
                  previewMutation.isPending || applyMutation.isPending
                }
              >
                Preview page creation
              </Button>
            </div>
          ) : null}
        </section>
      ) : (
        <section className="border-t border-rule pt-3">
          <h3 className="cl-mono text-[10px] font-bold uppercase tracking-[0.15em] text-ink">
            Navigation only
          </h3>
          <p className="mt-2 text-sm text-ink-mute">
            No in-place action is offered. Inspect the source evidence before
            changing it.
          </p>
        </section>
      )}

      {preview ? (
        <section
          aria-labelledby="repair-preview-heading"
          className="border-t border-rule pt-3"
        >
          <h3
            id="repair-preview-heading"
            className="cl-mono text-[10px] font-bold uppercase tracking-[0.15em] text-cool"
          >
            Preview evidence
          </h3>
          <div className="mt-2 grid gap-2 lg:grid-cols-2">
            <div>
              <p className="cl-mono text-[9px] uppercase tracking-[0.14em] text-ink-mute">
                Before
              </p>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap border border-rule bg-paper-2 p-3 font-mono text-xs text-ink-2">
                {preview.before}
              </pre>
            </div>
            <div>
              <p className="cl-mono text-[9px] uppercase tracking-[0.14em] text-ink-mute">
                After
              </p>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap border border-cool bg-paper-2 p-3 font-mono text-xs text-ink">
                {preview.after}
              </pre>
            </div>
          </div>
          <section
            aria-label="Mutation plan"
            className="mt-3 border-t border-rule pt-3"
          >
            <h4 className="cl-mono text-[9px] font-bold uppercase tracking-[0.14em] text-ink">
              Mutation plan
            </h4>
            {preview.plan.file_ops.length ? (
              <ul className="mt-2 divide-y divide-rule border border-rule">
                {preview.plan.file_ops.map((operation) => (
                  <li
                    key={`${operation.kind}-${operation.path}-${operation.destination ?? ""}`}
                    className="grid gap-1 px-3 py-2 text-xs"
                  >
                    <span className="cl-mono uppercase text-cool">
                      {operation.kind.replaceAll("_", " ")}
                    </span>
                    <code className="break-all text-ink">{operation.path}</code>
                    {operation.destination ? (
                      <code className="break-all text-ink-2">
                        Destination: {operation.destination}
                      </code>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-ink-mute">No file operations.</p>
            )}
            {preview.plan.text_edits.length ? (
              <ul className="mt-2 space-y-2">
                {preview.plan.text_edits.map((edit) => (
                  <li
                    key={`${edit.path}-${edit.old_text}-${edit.new_text}`}
                    className="border border-rule p-3"
                  >
                    <code className="break-all text-xs text-ink">
                      {edit.path}
                    </code>
                    <div className="mt-2 grid gap-2 lg:grid-cols-2">
                      <pre className="whitespace-pre-wrap bg-paper-2 p-2 font-mono text-xs text-ink-2">
                        {edit.old_text}
                      </pre>
                      <pre className="whitespace-pre-wrap border-l-2 border-cool bg-paper-2 p-2 font-mono text-xs text-ink">
                        {edit.new_text}
                      </pre>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-ink-mute">No text edits.</p>
            )}
          </section>
          <Button
            variant="primary"
            className="mt-3"
            onPress={() => void applyRepair()}
            isDisabled={previewMutation.isPending || applyMutation.isPending}
          >
            Apply previewed repair
          </Button>
        </section>
      ) : null}

      {status ? (
        <p role="status" aria-live="polite" className="text-sm text-cool">
          {status}
        </p>
      ) : null}
      {alert ? (
        <p role="alert" className="text-sm text-hot">
          {alert}
        </p>
      ) : null}
    </div>
  );
}
