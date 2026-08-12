import type { AttachmentInfo } from "#/api/attachments";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";

export type PendingAttachmentAction =
  | { kind: "upload"; file: File }
  | { kind: "insert"; attachment: AttachmentInfo; markdown: string };

export interface PlaintextAttachmentDialogProps {
  action: PendingAttachmentAction | null;
  error?: string | null;
  isPending?: boolean;
  onCancel: () => void;
  onAcknowledge: (action: PendingAttachmentAction) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PlaintextAttachmentDialog({
  action,
  error = null,
  isPending = false,
  onCancel,
  onAcknowledge,
}: PlaintextAttachmentDialogProps) {
  const upload = action?.kind === "upload" ? action.file : null;
  const attachment = action?.kind === "insert" ? action.attachment : null;
  const title = upload
    ? "Store plaintext attachment?"
    : "Insert plaintext attachment reference?";

  return (
    <Dialog
      isOpen={action !== null}
      onOpenChange={(open) => {
        if (!open && !isPending) onCancel();
      }}
      title={title}
      description="This acknowledgement applies only to this attachment action."
      size="md"
      isDismissable={!isPending}
      footer={
        <>
          <Button
            variant="secondary"
            onPress={onCancel}
            isDisabled={isPending}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            isDisabled={isPending}
            onPress={() => {
              if (action) onAcknowledge(action);
            }}
          >
            {upload ? "I understand, upload" : "I understand, insert"}
          </Button>
        </>
      }
    >
      {action ? (
        <div className="space-y-3 text-sm">
          <p className="text-warning">
            The attachment bytes, filename, path, MIME type, and size are not
            encrypted.
          </p>
          <ul className="space-y-1 break-all font-mono text-xs text-ink-mute">
            <li>Filename: {upload?.name ?? attachment?.name}</li>
            <li>
              {upload ? "Destination path" : "Attachment path"}:{" "}
              {upload?.name ?? attachment?.path}
            </li>
            <li>MIME type: {upload?.type || "not reported"}</li>
            <li>Size: {formatSize(upload?.size ?? attachment?.size ?? 0)}</li>
            {action.kind === "insert" ? (
              <li>Markdown reference: {action.markdown}</li>
            ) : null}
          </ul>
          {action.kind === "insert" ? (
            <p className="text-ink-mute">
              Only the Markdown reference becomes part of the protected note
              body. The existing attachment remains plaintext at its vault
              path.
            </p>
          ) : (
            <p className="text-ink-mute">
              Uploading stores this file outside the protected note body.
            </p>
          )}
          {error ? (
            <p role="alert" className="text-danger">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
