import { useId } from "react";
import type { MutationPreview } from "#/api/index";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";

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
      <div className="space-y-4 text-sm">
        <section aria-labelledby={`${headingId}-impact`}>
          <h3
            id={`${headingId}-impact`}
            className="text-xs font-bold uppercase tracking-widest text-muted-foreground"
          >
            Impact
          </h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            <li>
              {preview.file_ops.length} file operation
              {preview.file_ops.length === 1 ? "" : "s"}
            </li>
            {destructive ? (
              <li className="text-destructive">
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
          <h3
            id={`${headingId}-file-operations`}
            className="text-xs font-bold uppercase tracking-widest text-muted-foreground"
          >
            Affected paths
          </h3>
          {preview.file_ops.length === 0 ? (
            <p className="mt-2 text-muted-foreground">No file operations.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {preview.file_ops.map((operation, index) => (
                <li
                  key={`${operation.kind}-${operation.path}-${index}`}
                  className="border border-border px-3 py-2"
                >
                  <span className="cl-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {operation.kind.replace("_", " ")}
                  </span>
                  <div className="mt-1 break-all font-mono text-xs">
                    <span>{operation.path}</span>
                    {operation.destination ? (
                      <>
                        <span
                          aria-hidden
                          className="px-2 text-muted-foreground"
                        >
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
            <h3
              id={`${headingId}-link-rewrites`}
              className="text-xs font-bold uppercase tracking-widest text-muted-foreground"
            >
              Link rewrites
            </h3>
            <ul className="mt-2 space-y-2">
              {preview.text_edits.map((edit, index) => (
                <li
                  key={`${edit.path}-${index}`}
                  className="border border-border px-3 py-2"
                >
                  <div className="break-all font-mono text-xs font-semibold">
                    {edit.path}
                  </div>
                  <div className="mt-1 grid gap-1 font-mono text-xs text-muted-foreground">
                    <span className="break-all">Before: {edit.old_text}</span>
                    <span className="break-all">After: {edit.new_text}</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </Dialog>
  );
}
