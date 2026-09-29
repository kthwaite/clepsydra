import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  type AttachmentInfo,
  attachmentMarkdown,
  useUploadAttachment,
} from "#/api/attachments";
import { formatApiError } from "#/api/error";
import type { PendingAttachmentAction } from "#/components/attachments/PlaintextAttachmentDialog";
import { PlaintextAttachmentDialog } from "#/components/attachments/PlaintextAttachmentDialog";

interface AttachmentDropUploadOptions {
  protectedPage: boolean;
  disabled?: boolean;
  onUploaded: () => void;
}

interface Approval {
  action: PendingAttachmentAction;
  resolve: (approved: boolean) => void;
}

interface UploadProgress {
  name: string;
  position: number;
  total: number;
}

export function useAttachmentDropUpload({
  protectedPage,
  disabled = false,
  onUploaded,
}: AttachmentDropUploadOptions) {
  const { mutateAsync } = useUploadAttachment();
  const mounted = useRef(false);
  const activeBatch = useRef<{ cancelled: boolean } | null>(null);
  const approval = useRef<Approval | null>(null);
  const options = useRef({ protectedPage, disabled, onUploaded });
  const [pendingAction, setPendingAction] =
    useState<PendingAttachmentAction | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [errors, setErrors] = useState<{ position: number; message: string }[]>(
    [],
  );

  const stopBatch = useCallback(() => {
    if (activeBatch.current) activeBatch.current.cancelled = true;
    const pending = approval.current;
    approval.current = null;
    pending?.resolve(false);
  }, []);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopBatch();
    };
  }, [stopBatch]);

  useLayoutEffect(() => {
    options.current = { protectedPage, disabled, onUploaded };
    if (disabled) {
      stopBatch();
      setPendingAction(null);
      setProgress(null);
    }
  }, [protectedPage, disabled, onUploaded, stopBatch]);

  const settleApproval = (
    approved: boolean,
    action?: PendingAttachmentAction,
  ) => {
    const pending = approval.current;
    if (!pending || (action && pending.action !== action)) return;
    approval.current = null;
    setPendingAction(null);
    pending.resolve(approved);
  };

  const uploadFiles = useCallback(
    async (files: File[]): Promise<string | null> => {
      if (
        !mounted.current ||
        options.current.disabled ||
        activeBatch.current ||
        files.length === 0
      ) {
        return null;
      }

      const batch = { cancelled: false };
      activeBatch.current = batch;
      const markdown: string[] = [];
      setErrors([]);
      try {
        for (const [index, file] of files.entries()) {
          if (!mounted.current || batch.cancelled) break;
          setProgress({
            name: file.name,
            position: index + 1,
            total: files.length,
          });
          if (options.current.protectedPage) {
            const approved = await new Promise<boolean>((resolve) => {
              const action: PendingAttachmentAction = { kind: "upload", file };
              approval.current = { action, resolve };
              setPendingAction(action);
            });
            if (!approved || !mounted.current || batch.cancelled) break;
          }

          let attachment: AttachmentInfo;
          try {
            attachment = await mutateAsync({ file });
          } catch (error) {
            if (!mounted.current || batch.cancelled) break;
            setErrors((current) => [
              ...current,
              {
                position: index,
                message: `${file.name}: ${formatApiError(error, "Could not upload attachment.")}`,
              },
            ]);
            continue;
          }
          if (!mounted.current || batch.cancelled) break;
          markdown.push(attachmentMarkdown(attachment));
          options.current.onUploaded();
        }
      } finally {
        activeBatch.current = null;
        if (mounted.current) setProgress(null);
      }
      if (batch.cancelled || !mounted.current) return null;
      return markdown.length ? markdown.join("\n\n") : null;
    },
    [mutateAsync],
  );

  return {
    uploadFiles,
    feedback: (
      <>
        {progress ? (
          <p
            role="status"
            className="rounded-[12px] bg-raise px-3 py-2 text-[13px] text-mute"
          >
            {pendingAction ? "Awaiting approval for" : "Uploading"}{" "}
            {progress.name} ({progress.position} of {progress.total})
          </p>
        ) : null}
        {errors.length ? (
          <div
            role="alert"
            className="rounded-[12px] bg-raise px-3 py-2 text-[13px] text-hot"
          >
            <ul className="m-0 list-none space-y-1 break-all p-0">
              {errors.map((error) => (
                <li key={error.position}>{error.message}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <PlaintextAttachmentDialog
          action={pendingAction}
          onCancel={() => settleApproval(false)}
          onAcknowledge={(action) => settleApproval(true, action)}
        />
      </>
    ),
  };
}
