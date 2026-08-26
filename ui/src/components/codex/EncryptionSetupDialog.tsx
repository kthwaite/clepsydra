import { type FormEvent, useState } from "react";
import {
  useEncryptionConfig,
  useRewrapIdentity,
  useSetupEncryption,
} from "#/api/encryption";
import { Checkbox } from "#/components/ui/checkbox";
import {
  createVaultIdentity,
  recipientForIdentity,
  wrapIdentity,
} from "#/crypto/age";
import { useEncryptionActions } from "#/crypto/EncryptionProvider";
import { cn } from "#/lib/cn";
import { CodexModalShell } from "./CodexModalShell";

type SetupMethod = "password" | "import";

type PreparedIdentity = {
  identity: string;
  recipient: string;
  wrappedIdentity: string | null;
  keyId: string;
};

type EncryptionSetupDialogProps = {
  mode: "setup" | "change-password";
  onDismiss: () => void;
};

const MIN_PASSWORD_LENGTH = 12;

function safeMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.startsWith("Unable to ")) {
    return error.message;
  }
  return fallback;
}

export function EncryptionSetupDialog({
  mode,
  onDismiss,
}: EncryptionSetupDialogProps) {
  const config = useEncryptionConfig();
  const setup = useSetupEncryption();
  const rewrap = useRewrapIdentity();
  const actions = useEncryptionActions();
  const [method, setMethod] = useState<SetupMethod>("password");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [importedIdentity, setImportedIdentity] = useState("");
  const [prepared, setPrepared] = useState<PreparedIdentity | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const busy = submitting || setup.isPending || rewrap.isPending;

  const selectMethod = (next: SetupMethod) => {
    if (busy || next === method) return;
    setMethod(next);
    setPrepared(null);
    setAcknowledged(false);
    setError(null);
  };

  const preparePasswordIdentity = async () => {
    setError(null);
    if (password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError("Use an encryption password with at least 12 characters.");
      return;
    }
    setSubmitting(true);
    try {
      const created = await createVaultIdentity();
      const wrappedIdentity = await wrapIdentity(created.identity, password);
      setPrepared({
        identity: created.identity,
        recipient: created.recipient,
        wrappedIdentity,
        keyId: crypto.randomUUID(),
      });
      setAcknowledged(false);
      setPassword("");
      setConfirmation("");
    } catch (cause) {
      setError(safeMessage(cause, "Unable to prepare the vault identity."));
    } finally {
      setSubmitting(false);
    }
  };

  const validateImportedIdentity = async () => {
    setError(null);
    const identity = importedIdentity
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("AGE-SECRET-KEY-"));
    if (!identity) {
      setError("Unable to validate the age identity.");
      return;
    }
    setSubmitting(true);
    try {
      const recipient = await recipientForIdentity(identity);
      setPrepared({
        identity,
        recipient,
        wrappedIdentity: null,
        keyId: crypto.randomUUID(),
      });
      setAcknowledged(false);
    } catch {
      setPrepared(null);
      setAcknowledged(false);
      setError("Unable to validate the age identity.");
    } finally {
      setSubmitting(false);
    }
  };

  const finishSetup = async () => {
    if (!prepared || !acknowledged || busy) return;
    setError(null);
    setSubmitting(true);
    try {
      const response = await setup.mutateAsync({
        body: {
          key_id: prepared.keyId,
          recipient: prepared.recipient,
          ...(prepared.wrappedIdentity
            ? { wrapped_identity: prepared.wrappedIdentity }
            : {}),
        },
      });
      if (response.recipient !== prepared.recipient) {
        setError("The recipient returned by the server does not match.");
        return;
      }
      await actions.unlockWithImportedIdentity(prepared.identity);
      onDismiss();
    } catch (cause) {
      setError(safeMessage(cause, "Unable to finish encryption setup."));
    } finally {
      setSubmitting(false);
    }
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    if (password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError("Use an encryption password with at least 12 characters.");
      return;
    }
    const wrappedIdentity = config.data?.wrapped_identity;
    const expectedRevision = config.data?.revision;
    if (!wrappedIdentity || !expectedRevision) {
      setError("No wrapped vault identity is available to rewrap.");
      return;
    }
    setSubmitting(true);
    try {
      const currentPassword = importedIdentity;
      await actions.unlockWithPassword(currentPassword);
      const identity = actions.getIdentity();
      if (!identity) throw new Error("Unable to unlock the vault identity.");
      const recipient = await recipientForIdentity(identity);
      if (config.data?.recipient && recipient !== config.data.recipient) {
        throw new Error("Unable to verify the vault identity.");
      }
      const nextWrappedIdentity = await wrapIdentity(identity, password);
      await rewrap.mutateAsync({
        body: {
          expected_revision: expectedRevision,
          wrapped_identity: nextWrappedIdentity,
        },
      });
      onDismiss();
    } catch (cause) {
      setError(safeMessage(cause, "Unable to change the encryption password."));
    } finally {
      setImportedIdentity("");
      setPassword("");
      setConfirmation("");
      setSubmitting(false);
    }
  };

  const downloadRecoveryIdentity = () => {
    if (!prepared) return;
    const objectUrl = URL.createObjectURL(
      new Blob([`${prepared.identity}\n`], {
        type: "text/plain;charset=utf-8",
      }),
    );
    const anchor = document.createElement("a");
    anchor.download = `clepsydra-recovery-${prepared.keyId}.txt`;
    anchor.href = objectUrl;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
  };

  return (
    <CodexModalShell
      ariaLabel={
        mode === "setup" ? "Encryption setup" : "Change encryption password"
      }
      maxWidthClassName="max-w-[620px]"
      onDismiss={onDismiss}
    >
      <div className="flex items-baseline justify-between border-b border-ink bg-paper-2 px-3 py-1.5">
        <span className="cl-mono text-[10px] uppercase tracking-[0.18em]">
          ▣ Vault encryption
        </span>
        <span className="cl-mono text-[9px] uppercase tracking-[0.14em] text-ink-mute">
          age / local session only
        </span>
      </div>

      {mode === "change-password" ? (
        <form className="space-y-3 px-4 py-4" onSubmit={changePassword}>
          <p className="text-sm text-ink-mute">
            This replaces only the password-wrapped identity. Existing note
            ciphertext is not rewritten.
          </p>
          <LabeledInput
            label="Current password"
            type="password"
            value={importedIdentity}
            onChange={setImportedIdentity}
            disabled={busy}
          />
          <LabeledInput
            label="New encryption password"
            type="password"
            value={password}
            onChange={setPassword}
            disabled={busy}
          />
          <LabeledInput
            label="Confirm new encryption password"
            type="password"
            value={confirmation}
            onChange={setConfirmation}
            disabled={busy}
          />
          <ErrorNotice error={error} />
          <DialogActions onCancel={onDismiss} busy={busy}>
            <button type="submit" className="cl-btn cl-btn-hot" disabled={busy}>
              {busy ? "changing…" : "Change password"}
            </button>
          </DialogActions>
        </form>
      ) : (
        <div className="space-y-4 px-4 py-4">
          <fieldset className="m-0 flex min-w-0 border border-rule p-0">
            <legend className="sr-only">Identity method</legend>
            <MethodButton
              selected={method === "password"}
              onClick={() => selectMethod("password")}
            >
              Create with password
            </MethodButton>
            <MethodButton
              selected={method === "import"}
              onClick={() => selectMethod("import")}
            >
              Import existing identity
            </MethodButton>
          </fieldset>

          {!prepared && method === "password" ? (
            <div className="space-y-3">
              <p className="text-sm text-ink-mute">
                Generate a new age identity. Its recovery identity never leaves
                this browser unless you export it.
              </p>
              <LabeledInput
                label="Encryption password"
                type="password"
                value={password}
                onChange={setPassword}
                disabled={busy}
              />
              <LabeledInput
                label="Confirm encryption password"
                type="password"
                value={confirmation}
                onChange={setConfirmation}
                disabled={busy}
              />
              <button
                type="button"
                className="cl-btn cl-btn-hot"
                disabled={busy}
                onClick={() => void preparePasswordIdentity()}
              >
                {busy ? "generating…" : "Generate recovery identity"}
              </button>
            </div>
          ) : null}

          {!prepared && method === "import" ? (
            <div className="space-y-3">
              <label className="block">
                <span className="cl-mono text-[9px] uppercase tracking-[0.16em] text-ink-mute">
                  Age identity
                </span>
                <textarea
                  aria-label="Age identity"
                  value={importedIdentity}
                  onChange={(event) => setImportedIdentity(event.target.value)}
                  disabled={busy}
                  rows={4}
                  spellCheck={false}
                  className="cl-mono mt-1 w-full resize-y border border-rule bg-transparent p-2 text-[11px] outline-none focus:border-accent"
                />
              </label>
              <button
                type="button"
                className="cl-btn cl-btn-hot"
                disabled={busy}
                onClick={() => void validateImportedIdentity()}
              >
                {busy ? "validating…" : "Validate imported identity"}
              </button>
            </div>
          ) : null}

          {prepared ? (
            <div className="space-y-3 border border-rule bg-paper-2 p-3">
              <div>
                <div className="cl-mono text-[9px] uppercase tracking-[0.16em] text-ink-mute">
                  Recipient
                </div>
                <div className="cl-mono mt-1 break-all text-[11px]">
                  {prepared.recipient}
                </div>
              </div>
              {method === "password" ? (
                <button
                  type="button"
                  className="cl-btn"
                  onClick={downloadRecoveryIdentity}
                >
                  Download recovery identity
                </button>
              ) : null}
              <Checkbox
                isSelected={acknowledged}
                onChange={setAcknowledged}
              >
                {method === "password"
                  ? "I understand that losing both my password and recovery identity is unrecoverable."
                  : "I understand that losing this recovery identity is unrecoverable."}
              </Checkbox>
            </div>
          ) : null}

          <ErrorNotice error={error} />
          <DialogActions onCancel={onDismiss} busy={busy}>
            <button
              type="button"
              className="cl-btn cl-btn-hot"
              disabled={!prepared || !acknowledged || busy}
              onClick={() => void finishSetup()}
            >
              {busy ? "saving…" : "Finish encryption setup"}
            </button>
          </DialogActions>
        </div>
      )}
    </CodexModalShell>
  );
}

function LabeledInput({
  label,
  type,
  value,
  onChange,
  disabled,
}: {
  label: string;
  type: "password" | "text";
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="block">
      <span className="cl-mono text-[9px] uppercase tracking-[0.16em] text-ink-mute">
        {label}
      </span>
      <input
        aria-label={label}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        autoComplete="off"
        className="cl-mono mt-1 w-full border border-rule bg-transparent p-2 text-[12px] outline-none focus:border-accent"
      />
    </label>
  );
}

function MethodButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "flex-1 px-3 py-2 text-xs uppercase tracking-wider",
        selected ? "bg-ink text-paper" : "text-ink-mute hover:bg-paper-2",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ErrorNotice({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" aria-live="assertive" className="text-sm text-hot">
      ⁂ {error}
    </p>
  ) : null;
}

function DialogActions({
  onCancel,
  busy,
  children,
}: {
  onCancel: () => void;
  busy: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex justify-end gap-2">
      <button
        type="button"
        className="cl-btn"
        onClick={onCancel}
        disabled={busy}
      >
        cancel
      </button>
      {children}
    </div>
  );
}
