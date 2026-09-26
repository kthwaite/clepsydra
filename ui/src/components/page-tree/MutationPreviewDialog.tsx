import { type ReactNode, useId } from "react";
import type { MutationPreview } from "#/api/index";
import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { cn } from "#/lib/cn";

/** Sentence-case label for a file operation kind (`create_dir` → "Create dir"). */
function operationLabel(kind: string): string {
  const words = kind.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Rail eyebrow: tick + 18px italic serif, as in Section compact. */
function Eyebrow({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3
      id={id}
      className="flex items-center gap-2.5 font-serif text-[18px] font-normal italic leading-none text-mute"
    >
      <Tick />
      {children}
    </h3>
  );
}

export function MutationPreviewDialog({
  isOpen,
  title,
  confirmLabel,
  preview,
  isExecuting,
  error,
  onConfirm,
  onCancel,
}: {
  isOpen: boolean;
  title: string;
  confirmLabel: string;
  preview: MutationPreview;
  isExecuting: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const headingId = useId();
  const deletedPaths = preview.file_ops.filter((op) => op.kind === "delete");
  const destructive = deletedPaths.length > 0;

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open && !isExecuting) onCancel();
      }}
      title={title}
      description="This preview is tied to the exact paths and rewrite policy you submitted."
      size="lg"
      isDismissable={!isExecuting}
      footer={
        <>
          <Button
            variant="secondary"
            onPress={onCancel}
            isDisabled={isExecuting}
          >
            Back
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            onPress={onConfirm}
            isDisabled={isExecuting}
          >
            {isExecuting ? "Applying…" : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <section aria-labelledby={`${headingId}-impact`}>
          <Eyebrow id={`${headingId}-impact`}>Impact</Eyebrow>
          <ul className="mt-3 list-disc space-y-1 pl-[34px] text-ink-2 marker:text-faint">
            <li>
              {preview.file_ops.length} file operation
              {preview.file_ops.length === 1 ? "" : "s"}
            </li>
            {destructive ? (
              <li className="text-hot">
                {deletedPaths.length} path{deletedPaths.length === 1 ? "" : "s"}{" "}
                will be deleted
              </li>
            ) : null}
            <li>
              {preview.text_edits.length} link rewrite
              {preview.text_edits.length === 1 ? "" : "s"}
            </li>
          </ul>
        </section>

        <section aria-labelledby={`${headingId}-file-operations`}>
          <Eyebrow id={`${headingId}-file-operations`}>Affected paths</Eyebrow>
          {preview.file_ops.length === 0 ? (
            <p className="mt-3 pl-[17px] text-mute">No file operations.</p>
          ) : (
            <ul className="mt-3 flex list-none flex-col gap-1 pl-[17px]">
              {preview.file_ops.map((operation) => (
                <li
                  key={`${operation.kind}-${operation.path}-${operation.destination ?? ""}`}
                  className="rounded-[10px] bg-ground px-3 py-2"
                >
                  <span
                    className={cn(
                      "text-[13px]",
                      operation.kind === "delete" ? "text-hot" : "text-ink-2",
                    )}
                  >
                    {operationLabel(operation.kind)}
                  </span>
                  <div className="mt-0.5 break-all text-[13px] text-mute">
                    <span>{operation.path}</span>
                    {operation.destination ? (
                      <>
                        <span aria-hidden className="px-2 text-faint">
                          →
                        </span>
                        <span>{operation.destination}</span>
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {preview.text_edits.length > 0 ? (
          <section aria-labelledby={`${headingId}-link-rewrites`}>
            <Eyebrow id={`${headingId}-link-rewrites`}>Link rewrites</Eyebrow>
            <ul className="mt-3 flex list-none flex-col gap-1 pl-[17px]">
              {preview.text_edits.map((edit) => (
                <li
                  key={`${edit.path}-${edit.old_text}-${edit.new_text}`}
                  className="rounded-[10px] bg-ground px-3 py-2"
                >
                  <div className="break-all text-[13px] text-mute">
                    {edit.path}
                  </div>
                  <div className="mt-1 grid gap-0.5 text-[12.5px] text-ink-2">
                    <code className="break-all">Before: {edit.old_text}</code>
                    <code className="break-all">After: {edit.new_text}</code>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {error ? <p className="text-[13px] text-hot">{error}</p> : null}
      </div>
    </Dialog>
  );
}
