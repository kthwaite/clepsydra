import { useState } from "react";
import {
  useEncryptionConfig,
  useProtectPage,
  useUnprotectPage,
} from "#/api/encryption";
import { Checkbox } from "#/components/ui/checkbox";
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
      onDismiss={onDismiss}
    >
      <div className="border-b border-ink bg-paper-2 px-3 py-1.5">
        <span className="cl-mono text-[10px] uppercase tracking-[0.18em]">
          {protecting ? "▣ Protect note" : "⚠ Remove encryption"}
        </span>
      </div>
      <div className="space-y-4 px-4 py-4">
        <p className="text-sm">
          {protecting
            ? "Only the Markdown body will be encrypted. The following information remains visible:"
            : "This destructive transition writes the decrypted Markdown body back to disk as plaintext."}
        </p>
        <div className="cl-mono space-y-1 border border-rule bg-paper-2 p-3 text-[11px]">
          <p>Title · {page.title || "(untitled)"}</p>
          <p>Tags · {page.tags.length > 0 ? page.tags.join(", ") : "(none)"}</p>
          <p>Path · {page.path}</p>
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
          <p role="alert" aria-live="assertive" className="text-sm text-hot">
            ⁂ {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="cl-btn"
            onClick={onDismiss}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="cl-btn cl-btn-hot"
            disabled={!acknowledged || busy}
            onClick={() => void transition()}
          >
            {busy
              ? "saving…"
              : protecting
                ? "Protect note"
                : "Remove encryption"}
          </button>
        </div>
      </div>
    </CodexModalShell>
  );
}
