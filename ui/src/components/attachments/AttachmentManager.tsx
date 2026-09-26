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
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
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
  const scopedToPage = pageMarkdown !== undefined;
  const referencedPaths = useMemo(
    () =>
      new Set(
        attachmentReferences(pageMarkdown ?? "").map(
          (reference) => reference.path,
        ),
      ),
    [pageMarkdown],
  );
  const [showAll, setShowAll] = useState(false);
  const referencedAttachments = useMemo(
    () =>
      (attachments ?? []).filter((attachment) =>
        referencedPaths.has(canonicalAttachmentPath(attachment.path)),
      ),
    [attachments, referencedPaths],
  );
  const visibleAttachments = useMemo(() => {
    if (!attachments || !scopedToPage || showAll) return attachments;
    return referencedAttachments;
  }, [attachments, referencedAttachments, scopedToPage, showAll]);
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
      const attachment = await upload.mutateAsync({ file });
      setShowAll(true);
      return attachment;
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
    <section aria-label="Attachments" className="text-[13.5px] text-ink-2">
      {protectedPage ? (
        <p className="mb-3 rounded-[12px] bg-hot/5 px-3 py-2 text-warn">
          Attachments are not encrypted. Only the note body is protected.
        </p>
      ) : null}
      {missingReferences.length ? (
        <section
          aria-label="Plaintext attachment references"
          className="mb-3 rounded-[12px] bg-hot/5 px-3 py-2 text-warn"
        >
          <p className="font-medium">Plaintext attachment references</p>
          <p>These references do not match the current attachment inventory:</p>
          <ul className="m-0 mt-1 list-disc break-all pl-4">
            {missingReferences.map((reference) => (
              <li key={reference.path}>{reference.path}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mb-3">
        <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-full bg-sink px-4 text-[13.5px] text-ink transition-colors hover:text-accent focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-2 focus-within:ring-offset-ground">
          <Upload aria-hidden size={14} />
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
          <p className="mt-2 text-[13px] text-mute">
            Attachment bytes, filename, path, MIME type, and size are stored as
            plaintext and are not encrypted.
          </p>
        ) : null}
      </div>

      {actionError ? (
        <p role="alert" className="mb-2 text-[13px] text-hot">
          {actionError}
        </p>
      ) : null}
      {scopedToPage && attachments?.length ? (
        <button
          type="button"
          onClick={() => setShowAll((current) => !current)}
          className={cn(
            "mb-2 cursor-pointer rounded text-[13px] text-accent hover:underline",
            FOCUS_RING_NATIVE,
          )}
        >
          {showAll
            ? `Show referenced attachments (${referencedAttachments.length})`
            : `Show all attachments (${attachments.length})`}
        </button>
      ) : null}
      {error ? (
        <p role="alert" className="text-[13px] text-hot">
          {formatApiError(error, "Could not load attachments.")}
        </p>
      ) : isLoading ? (
        <p className="text-[13px] text-mute">Loading attachments…</p>
      ) : !attachments?.length ? (
        <p className="text-[13px] text-mute">No attachments in this vault.</p>
      ) : !visibleAttachments?.length ? (
        <p className="text-[13px] text-mute">
          No attachments referenced by this page.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {visibleAttachments.map((attachment) => {
            const markdown = attachmentMarkdown(attachment);
            const pendingDelete = deletePath === attachment.path;
            const Icon = isImage(attachment) ? Image : File;
            return (
              <li
                key={attachment.path}
                className="rounded-[12px] bg-raise px-3 py-2"
              >
                <div className="flex min-w-0 items-start gap-2">
                  <Icon
                    aria-hidden
                    size={14}
                    className="mt-[3px] shrink-0 text-accent"
                  />
                  <div className="min-w-0 flex-1">
                    <a
                      href={attachmentUrl(attachment.path)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cn(
                        "block truncate rounded text-ink hover:underline",
                        FOCUS_RING_NATIVE,
                      )}
                    >
                      {attachment.name}
                    </a>
                    <span className="text-[12px] text-mute">
                      {formatSize(attachment.size)}
                    </span>
                  </div>
                  <CopyButton
                    getText={() => markdown}
                    label={`Copy Markdown for ${attachment.name}`}
                  />
                </div>
                <div className="mt-1.5 flex items-center gap-3">
                  {onInsertMarkdown ? (
                    <button
                      type="button"
                      className={cn(
                        "inline-flex cursor-pointer items-center gap-1 rounded text-[13px] text-accent hover:underline",
                        FOCUS_RING_NATIVE,
                      )}
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
                      <Paperclip aria-hidden size={13} />
                      <span className="sr-only">Insert {attachment.name}</span>
                      <span aria-hidden>Insert</span>
                    </button>
                  ) : null}
                  {pendingDelete ? (
                    <>
                      <button
                        type="button"
                        className={cn(
                          "cursor-pointer rounded text-[13px] text-hot hover:underline",
                          FOCUS_RING_NATIVE,
                        )}
                        disabled={remove.isPending}
                        onClick={() => void confirmDelete(attachment)}
                      >
                        Confirm delete {attachment.name}
                      </button>
                      <button
                        type="button"
                        className={cn(
                          "cursor-pointer rounded text-[13px] text-mute hover:text-ink",
                          FOCUS_RING_NATIVE,
                        )}
                        onClick={() => setDeletePath(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Delete ${attachment.name}`}
                      className={cn(
                        "ml-auto inline-flex cursor-pointer items-center rounded text-mute transition-colors hover:text-hot",
                        FOCUS_RING_NATIVE,
                      )}
                      onClick={() => setDeletePath(attachment.path)}
                    >
                      <Trash2 aria-hidden size={14} />
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
