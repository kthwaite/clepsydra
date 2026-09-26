import { useRef, useState } from "react";
import { Input, Label, TextField } from "react-aria-components";
import {
  type ReferenceIssue,
  ReferenceRepairApiError,
  type ReferenceRepairPreview,
  type ReferenceRepairRequest,
  useApplyReferenceRepair,
  usePreviewReferenceRepair,
} from "#/api/index";
import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { issueLabel, KIND_LABELS } from "./RepairIssueList";

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Wikilinks and block refs are the evidence tokens a snippet can carry. */
const EVIDENCE_TOKEN = /(\[\[[^\]]*\]\]|\(\([^)]*\)\))/;

function EvidenceText({ snippet }: { snippet: string }) {
  return (
    <>
      {snippet.split(EVIDENCE_TOKEN).map((part, index) =>
        index % 2 === 1 ? (
          <mark
            // biome-ignore lint/suspicious/noArrayIndexKey: split parts are positional
            key={index}
            className="rounded bg-accent-tint px-1 py-px text-ink"
          >
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

function countLabel(count: number, singular: string): string {
  if (count === 0) return `no ${singular}s`;
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function planSummary(plan: ReferenceRepairPreview["plan"]): string {
  return `${countLabel(plan.text_edits.length, "text edit")} · ${countLabel(
    plan.file_ops.length,
    "file operation",
  )}`;
}

function Eyebrow({
  id,
  faint = false,
  children,
}: {
  id?: string;
  faint?: boolean;
  children: string;
}) {
  return (
    <h3 id={id} className="flex items-center gap-2.5">
      <Tick variant={faint ? "faint" : "live"} />
      <span className="font-serif text-[19px] italic leading-none text-mute">
        {children}
      </span>
    </h3>
  );
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

  const statusLine = status ? (
    <p role="status" aria-live="polite" className="text-[13px] text-mute">
      {status}
    </p>
  ) : null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end gap-x-5 gap-y-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="flex flex-wrap items-center gap-x-2 text-[13px] text-mute">
            <span
              aria-hidden
              className="inline-block size-1.5 shrink-0 rounded-full bg-hot"
            />
            <span className="text-hot">{KIND_LABELS[issue.kind]}</span>
            <span aria-hidden>·</span>
            <span className="break-all">{issue.source_path}</span>
            {issue.source_field ? (
              <>
                <span aria-hidden>·</span>
                <span className="break-all">{issue.source_field}</span>
              </>
            ) : null}
          </p>
          <h2 className="break-words font-serif text-[32px] leading-[1.05] text-ink md:text-[38px]">
            {issueLabel(issue)}
          </h2>
        </div>
        {issue.actions.includes("open_source") ? (
          <Button
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
      </header>

      <section
        aria-labelledby="repair-evidence-heading"
        className="flex flex-col gap-3"
      >
        <Eyebrow id="repair-evidence-heading">Source evidence</Eyebrow>
        {issue.snippet ? (
          <p className="ml-[17px] whitespace-pre-wrap break-words rounded-xl bg-sink px-[18px] py-3.5 text-[14.5px] leading-relaxed text-ink-2">
            <EvidenceText snippet={issue.snippet} />
          </p>
        ) : (
          <p className="ml-[17px] rounded-xl bg-sink px-[18px] py-3.5 text-[14px] text-mute">
            {issue.kind === "orphan_page"
              ? "This page has no incoming references. Open the source to decide whether it should be linked, moved, or removed."
              : issue.kind === "isolated_page"
                ? "This page has no incoming or outgoing references. Open the source to reconnect it to the vault."
                : "Source text is unavailable or redacted. Open the source to inspect the reference."}
          </p>
        )}
      </section>

      {canRepair ? (
        <section
          aria-labelledby="repair-actions-heading"
          className="flex flex-col gap-2.5"
        >
          <Eyebrow id="repair-actions-heading">Repair action</Eyebrow>

          <div className="ml-[17px] flex flex-col gap-0.5">
            {issue.actions.includes("replace") && issue.candidates.length > 0
              ? issue.candidates.map((candidate) => (
                  <div
                    key={candidate.page_id}
                    className="flex items-center gap-3.5 rounded-xl py-1.5 pr-2 pl-3.5"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <p className="break-words text-[14.5px] font-medium text-ink">
                        {candidate.title || candidate.path}
                      </p>
                      <p className="break-all text-[12.5px] text-mute">
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
                ))
              : null}

            {issue.actions.includes("create") ? (
              <div className="flex flex-col gap-3 pt-1.5 pl-3.5">
                <div className="flex flex-wrap items-center gap-3 text-[13.5px] text-mute">
                  <span>
                    {issue.candidates.length > 0 &&
                    issue.actions.includes("replace")
                      ? "Or create the page in"
                      : "Create the page in"}
                  </span>
                  <TextField
                    value={folder}
                    onChange={(value) => {
                      setFolder(value);
                      invalidatePreview();
                    }}
                    className="flex h-8 items-center rounded-full bg-sink px-3 focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-2 focus-within:ring-offset-ground"
                  >
                    <Label className="sr-only">New page folder</Label>
                    <Input
                      placeholder="Vault root"
                      className="w-40 min-w-0 bg-transparent text-ink outline-none placeholder:text-mute"
                    />
                  </TextField>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-accent data-[hovered]:text-accent"
                    onPress={() =>
                      void previewRepair({
                        fingerprint: issue.fingerprint,
                        source_revision: issue.source_revision,
                        action: {
                          type: "create",
                          folder: folder.trim(),
                          body,
                        },
                      })
                    }
                    isDisabled={
                      previewMutation.isPending || applyMutation.isPending
                    }
                  >
                    Preview page creation
                  </Button>
                </div>
                <label className="flex flex-col gap-1.5 text-[12.5px] text-mute">
                  Initial body
                  <textarea
                    value={body}
                    onChange={(event) => {
                      setBody(event.target.value);
                      invalidatePreview();
                    }}
                    rows={3}
                    className={cn(
                      "block w-full resize-y rounded-xl bg-sink px-4 py-2.5 text-[14px] text-ink",
                      FOCUS_RING_NATIVE,
                    )}
                  />
                </label>
              </div>
            ) : null}
          </div>
        </section>
      ) : (
        <section
          aria-labelledby="repair-navigation-heading"
          className="flex flex-col gap-2.5"
        >
          <Eyebrow id="repair-navigation-heading" faint>
            Navigation only
          </Eyebrow>
          <p className="ml-[17px] text-[14px] text-mute">
            No in-place action is offered. Inspect the source evidence before
            changing it.
          </p>
        </section>
      )}

      {preview ? (
        <section
          aria-labelledby="repair-preview-heading"
          className="flex flex-col gap-3"
        >
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <Eyebrow id="repair-preview-heading">Preview</Eyebrow>
            <span className="text-[12.5px] text-mute">
              {planSummary(preview.plan)}
            </span>
          </div>
          <div className="ml-[17px] grid gap-2.5 lg:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5 rounded-xl bg-sink px-4 py-3">
              <span className="text-[12.5px] text-mute">Before</span>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2 line-through decoration-hot">
                {preview.before}
              </pre>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5 rounded-xl bg-accent-tint px-4 py-3">
              <span className="text-[12.5px] text-accent">After</span>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed text-accent">
                {preview.after}
              </pre>
            </div>
          </div>
          <section
            aria-label="Mutation plan"
            className="ml-[17px] flex flex-col gap-2 text-[12.5px] text-mute"
          >
            {preview.plan.file_ops.length ? (
              <ul className="flex flex-col gap-1">
                {preview.plan.file_ops.map((operation) => (
                  <li
                    key={`${operation.kind}-${operation.path}-${operation.destination ?? ""}`}
                    className="flex flex-wrap items-baseline gap-x-2"
                  >
                    <span className="text-ink-2">
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
            ) : null}
            {preview.plan.text_edits.length ? (
              <ul className="flex flex-col gap-2">
                {preview.plan.text_edits.map((edit) => (
                  <li
                    key={`${edit.path}-${edit.old_text}-${edit.new_text}`}
                    className="flex flex-col gap-1.5"
                  >
                    <code className="break-all text-ink-2">{edit.path}</code>
                    <div className="grid gap-1.5 lg:grid-cols-2">
                      <pre className="whitespace-pre-wrap break-words rounded-xl bg-sink px-3 py-2 text-[12.5px] text-ink-2 line-through decoration-hot">
                        {edit.old_text}
                      </pre>
                      <pre className="whitespace-pre-wrap break-words rounded-xl bg-accent-tint px-3 py-2 text-[12.5px] text-accent">
                        {edit.new_text}
                      </pre>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
          <div className="ml-[17px] flex flex-wrap items-center gap-4">
            <Button
              variant="primary"
              onPress={() => void applyRepair()}
              isDisabled={previewMutation.isPending || applyMutation.isPending}
            >
              Apply previewed repair
            </Button>
            {statusLine}
          </div>
        </section>
      ) : (
        statusLine
      )}
      {alert ? (
        <p role="alert" className="text-[13.5px] text-hot">
          {alert}
        </p>
      ) : null}
    </div>
  );
}
