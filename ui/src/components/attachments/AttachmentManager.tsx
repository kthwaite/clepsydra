import { File, Image, Paperclip, Trash2, Upload } from "lucide-react";
import { type ChangeEvent, useMemo, useRef, useState } from "react";
import {
  type AttachmentInfo,
  attachmentMarkdown,
  attachmentUrl,
  useAttachments,
  useDeleteAttachment,
  useUploadAttachment,
} from "#/api/attachments";
import { formatApiError } from "#/api/error";
import { CopyButton } from "#/components/ui/CopyButton";
import {
  attachmentReferences,
  canonicalAttachmentPath,
} from "#/lib/markdown/attachmentReferences";
import {
  type PendingAttachmentAction,
  PlaintextAttachmentDialog,
} from "./PlaintextAttachmentDialog";

interface AttachmentManagerProps {
  onInsertMarkdown?: (markdown: string) => void;
  protectedPage?: boolean;
  pageMarkdown?: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImage(attachment: AttachmentInfo): boolean {
  return attachmentMarkdown(attachment).startsWith("!");
}

export function AttachmentManager({
  onInsertMarkdown,
  pageMarkdown,
  protectedPage = false,
}: AttachmentManagerProps) {
  const { data: attachments, isLoading, error } = useAttachments();
  const upload = useUploadAttachment();
  const remove = useDeleteAttachment();
  const [deletePath, setDeletePath] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] =
    useState<PendingAttachmentAction | null>(null);
  const pendingActionInFlight = useRef<PendingAttachmentAction | null>(null);
  const [isPendingAction, setIsPendingAction] = useState(false);
  const missingReferences = useMemo(() => {
    if (!protectedPage || isLoading || error || !attachments) return [];
    const attachmentPaths = new Set(
      attachments.map((attachment) => canonicalAttachmentPath(attachment.path)),
    );
    return attachmentReferences(pageMarkdown ?? "").filter(
      (reference) => !attachmentPaths.has(reference.path),
    );
  }, [attachments, error, isLoading, pageMarkdown, protectedPage]);

  const uploadFile = async (file: File): Promise<AttachmentInfo | null> => {
    setActionError(null);
    try {
      return await upload.mutateAsync({ file });
    } catch (uploadError) {
      setActionError(
        formatApiError(uploadError, `Could not upload ${file.name}.`),
      );
      return null;
    }
  };

  const onUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = "";
    setActionError(null);
    if (protectedPage) {
      setPendingAction({ kind: "upload", file });
      return;
    }

    await uploadFile(file);
  };

  const acknowledgePendingAction = async (action: PendingAttachmentAction) => {
    if (pendingActionInFlight.current) return;
    pendingActionInFlight.current = action;
    setIsPendingAction(true);
    let succeeded = false;
    try {
      if (action.kind === "upload") {
        const attachment = await uploadFile(action.file);
        if (!attachment) return;
        onInsertMarkdown?.(attachmentMarkdown(attachment));
      } else {
        onInsertMarkdown?.(action.markdown);
      }
      succeeded = true;
    } finally {
      pendingActionInFlight.current = null;
      setIsPendingAction(false);
      if (succeeded) {
        setPendingAction((current) => (current === action ? null : current));
      }
    }
  };

  const cancelPendingAction = () => {
    if (pendingActionInFlight.current) return;
    setPendingAction(null);
    setActionError(null);
  };

  const confirmDelete = async (attachment: AttachmentInfo) => {
    setActionError(null);
    try {
      await remove.mutateAsync({
        params: { path: { path: attachment.path } },
      });
      setDeletePath(null);
    } catch (deleteError) {
      setActionError(
        formatApiError(deleteError, `Could not delete ${attachment.name}.`),
      );
    }
  };

  return (
    <section aria-label="Attachments" className="cl-mono text-[10px]">
      {protectedPage ? (
        <p className="mb-2 border-l-2 border-warning pl-2 text-warning">
          Attachments are not encrypted. Only the note body is protected.
        </p>
      ) : null}
      {missingReferences.length ? (
        <section
          aria-label="Plaintext attachment references"
          className="mb-2 border-l-2 border-warning pl-2 text-warning"
        >
          <p className="font-semibold">Plaintext attachment references</p>
          <p>These references do not match the current attachment inventory:</p>
          <ul className="m-0 list-disc pl-4">
            {missingReferences.map((reference) => (
              <li key={reference.path}>{reference.path}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mb-2">
        <label className="inline-flex cursor-pointer items-center gap-1.5 border border-rule px-2 py-1 uppercase tracking-[0.1em] text-ink-mute hover:border-accent hover:text-accent">
          <Upload aria-hidden size={12} />
          {upload.isPending ? "Uploading…" : "Upload"}
          <input
            type="file"
            aria-label="Upload attachment"
            className="sr-only"
            disabled={upload.isPending}
            onChange={(event) => void onUpload(event)}
          />
        </label>
        {!protectedPage ? (
          <p className="mt-1 text-ink-mute">
            Attachment bytes, filename, path, MIME type, and size are stored as
            plaintext and are not encrypted.
          </p>
        ) : null}
      </div>

      {actionError ? (
        <p role="alert" className="mb-2 text-danger">
          {actionError}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-danger">
          {formatApiError(error, "Could not load attachments.")}
        </p>
      ) : isLoading ? (
        <p className="text-ink-mute">Loading attachments…</p>
      ) : !attachments?.length ? (
        <p className="text-ink-mute">No attachments in this vault.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {attachments.map((attachment) => {
            const markdown = attachmentMarkdown(attachment);
            const pendingDelete = deletePath === attachment.path;
            const Icon = isImage(attachment) ? Image : File;
            return (
              <li
                key={attachment.path}
                className="border border-rule-soft px-2 py-1.5"
              >
                <div className="flex min-w-0 items-start gap-1.5">
                  <Icon
                    aria-hidden
                    size={12}
                    className="mt-0.5 shrink-0 text-accent"
                  />
                  <div className="min-w-0 flex-1">
                    <a
                      href={attachmentUrl(attachment.path)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate text-ink hover:underline"
                    >
                      {attachment.name}
                    </a>
                    <span className="text-[9px] text-ink-mute">
                      {formatSize(attachment.size)}
                    </span>
                  </div>
                  <CopyButton
                    getText={() => markdown}
                    label={`Copy Markdown for ${attachment.name}`}
                  />
                </div>
                <div className="mt-1 flex items-center gap-2 border-t border-rule-soft pt-1">
                  {onInsertMarkdown ? (
                    <button
                      type="button"
                      className="cursor-pointer uppercase tracking-[0.08em] text-accent hover:underline"
                      onClick={() => {
                        if (protectedPage) {
                          setPendingAction({
                            kind: "insert",
                            attachment,
                            markdown,
                          });
                        } else {
                          onInsertMarkdown(markdown);
                        }
                      }}
                    >
                      <Paperclip
                        aria-hidden
                        className="mr-1 inline"
                        size={10}
                      />
                      <span className="sr-only">Insert {attachment.name}</span>
                      <span aria-hidden>Insert</span>
                    </button>
                  ) : null}
                  {pendingDelete ? (
                    <>
                      <button
                        type="button"
                        className="cursor-pointer uppercase tracking-[0.08em] text-danger hover:underline"
                        disabled={remove.isPending}
                        onClick={() => void confirmDelete(attachment)}
                      >
                        Confirm delete {attachment.name}
                      </button>
                      <button
                        type="button"
                        className="cursor-pointer text-ink-mute hover:text-ink"
                        onClick={() => setDeletePath(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Delete ${attachment.name}`}
                      className="ml-auto cursor-pointer text-ink-mute hover:text-danger"
                      onClick={() => setDeletePath(attachment.path)}
                    >
                      <Trash2 aria-hidden size={11} />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <PlaintextAttachmentDialog
        action={pendingAction}
        error={actionError}
        isPending={isPendingAction}
        onCancel={cancelPendingAction}
        onAcknowledge={(action) => void acknowledgePendingAction(action)}
      />
    </section>
  );
}
