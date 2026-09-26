import { X } from "lucide-react";
import { useState } from "react";
import {
  useEncryptionConfig,
  useProtectPage,
  useUnprotectPage,
} from "#/api/encryption";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { IconButton } from "#/components/ui/icon-button";
import { encryptMarkdown } from "#/crypto/age";
import {
  useEncryptionActions,
  useEncryptionStatus,
} from "#/crypto/EncryptionProvider";
import { CodexModalShell } from "./CodexModalShell";

type ProtectionPage = {
  id: string;
  path: string;
  title: string;
  tags: string[];
};

type NoteProtectionDialogProps = {
  mode: "protect" | "unprotect";
  page: ProtectionPage;
  saveNow: () => Promise<void>;
  getPlaintext: () => string;
  getRevision: () => string;
  onComplete: () => void;
  onDismiss: () => void;
};

export function NoteProtectionDialog({
  mode,
  page,
  saveNow,
  getPlaintext,
  getRevision,
  onComplete,
  onDismiss,
}: NoteProtectionDialogProps) {
  const config = useEncryptionConfig();
  const status = useEncryptionStatus();
  const actions = useEncryptionActions();
  const protect = useProtectPage();
  const unprotect = useUnprotectPage();
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = submitting || protect.isPending || unprotect.isPending;

  const transition = async () => {
    if (!acknowledged || busy) return;
    setError(null);
    const identity = actions.getIdentity();
    if (
      !config.data?.initialized ||
      !config.data.key_id ||
      !config.data.recipient ||
      status.status !== "unlocked" ||
      !identity
    ) {
      setError("Set up and unlock vault encryption first.");
      return;
    }

    setSubmitting(true);
    try {
      try {
        await saveNow();
      } catch {
        setError("Unable to save before changing protection.");
        return;
      }
      const body = getPlaintext();
      const expectedRevision = getRevision();
      if (mode === "protect") {
        const encryptedBody = await encryptMarkdown(
          body,
          config.data.recipient,
        );
        await protect.mutateAsync({
          params: { path: { uuid: page.id } },
          body: {
            expected_revision: expectedRevision,
            body: encryptedBody,
            encryption: {
              format: "age",
              version: 1,
              key_id: config.data.key_id,
            },
          },
        });
      } else {
        await unprotect.mutateAsync({
          params: { path: { uuid: page.id } },
          body: { expected_revision: expectedRevision, body },
        });
      }
      onComplete();
      onDismiss();
    } catch {
      setError(
        mode === "protect"
          ? "Unable to protect this note."
          : "Unable to remove encryption from this note.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const protecting = mode === "protect";
  return (
    <CodexModalShell
      ariaLabel={protecting ? "Protect note" : "Remove note encryption"}
      maxWidthClassName="max-w-[580px]"
      panelClassName="rounded-[18px]"
      onDismiss={onDismiss}
    >
      <div className="flex flex-col gap-6 px-6 py-7 md:px-9 md:py-8">
        <DialogHeading
          title={protecting ? "Protect note" : "Remove encryption"}
          onClose={onDismiss}
          closeDisabled={busy}
        />
        <p className="text-[14.5px] leading-[1.55] text-ink-2">
          {protecting
            ? "Only the Markdown body will be encrypted. The following information remains visible:"
            : "This destructive transition writes the decrypted Markdown body back to disk as plaintext."}
        </p>
        <div className="flex flex-col gap-1.5 rounded-[14px] bg-sink px-[22px] py-5 text-[13.5px] leading-[1.5] text-ink-2">
          <p className="break-all">Title · {page.title || "(untitled)"}</p>
          <p>Tags · {page.tags.length > 0 ? page.tags.join(", ") : "(none)"}</p>
          <p className="break-all">Path · {page.path}</p>
          <p>Attachments are not encrypted.</p>
          <p>Git and filesystem history are not encrypted.</p>
        </div>
        <Checkbox
          isSelected={acknowledged}
          onChange={setAcknowledged}
          isDisabled={busy}
        >
          {protecting
            ? "I understand what remains visible and have exported a recovery identity."
            : "I understand this will make this note plaintext on disk."}
        </Checkbox>
        {error ? (
          <p
            role="alert"
            aria-live="assertive"
            className="text-[13.5px] text-hot"
          >
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onPress={onDismiss} isDisabled={busy}>
            Cancel
          </Button>
          <Button
            variant={protecting ? "primary" : "danger"}
            isDisabled={!acknowledged || busy}
            onPress={() => void transition()}
          >
            {busy
              ? "Saving…"
              : protecting
                ? "Protect note"
                : "Remove encryption"}
          </Button>
        </div>
      </div>
    </CodexModalShell>
  );
}

/** Serif title, optional mute subtitle and a round close button — the shared head
 *  of the encryption dialogs. */
export function DialogHeading({
  title,
  subtitle,
  onClose,
  closeDisabled = false,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  closeDisabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h2 className="font-serif text-[34px] font-normal leading-[1.05] text-ink">
          {title}
        </h2>
        {subtitle ? (
          <span className="text-[13px] text-mute">{subtitle}</span>
        ) : null}
      </div>
      <IconButton
        aria-label="Close dialog"
        onPress={onClose}
        isDisabled={closeDisabled}
      >
        <X />
      </IconButton>
    </div>
  );
}
