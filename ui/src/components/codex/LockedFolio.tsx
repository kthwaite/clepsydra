import { type ReactNode, useState } from "react";
import { useEncryptionConfig } from "#/api/encryption";
import { useEncryptionActions } from "#/crypto/EncryptionProvider";
import type { DecryptedBodyState } from "#/editor/useDecryptedPageBody";

type LockedFolioProps = {
  path: string;
  title: string;
  tags: string[];
  derivedTags?: string[];
  state: Exclude<DecryptedBodyState, { status: "plain" }>;
  properties?: ReactNode;
};

export function LockedFolio({
  path,
  title,
  tags,
  derivedTags = [],
  state,
  properties,
}: LockedFolioProps) {
  const config = useEncryptionConfig();
  const actions = useEncryptionActions();
  const [password, setPassword] = useState("");
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [recoveryIdentity, setRecoveryIdentity] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlockWithPassword = async () => {
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      await actions.unlockWithPassword(password);
    } catch {
      setError("Unable to unlock this note. Check the password and try again.");
    } finally {
      setPassword("");
      setBusy(false);
    }
  };

  const unlockWithRecovery = async () => {
    if (busy || !recoveryIdentity.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await actions.unlockWithImportedIdentity(recoveryIdentity.trim());
    } catch {
      setError("Unable to validate the recovery identity.");
    } finally {
      setRecoveryIdentity("");
      setBusy(false);
    }
  };

  return (
    <div className="cl-noscroll h-full overflow-auto">
      <main className="mx-auto max-w-[760px] px-7 py-10">
        <div className="cl-mono mb-5 border-b border-rule pb-2 text-[10px] uppercase tracking-[0.18em] text-ink-mute">
          Protected folio
        </div>
        <h1 className="font-heading text-2xl font-bold">{title || path}</h1>
        <p className="cl-mono mt-2 break-all text-[11px] text-ink-mute">
          {path}
        </p>
        {tags.length > 0 ? (
          <p
            aria-label="Tags"
            className="cl-mono mt-2 text-[11px] text-accent"
          >
            {tags.map((tag) => `#${tag}`).join(" ")}
          </p>
        ) : null}
        {derivedTags.length > 0 ? (
          <p
            aria-label="Read-only Tags"
            className="cl-mono mt-2 text-[11px] text-accent"
          >
            {derivedTags.map((tag) => `#${tag}`).join(" ")}
          </p>
        ) : null}

        <section className="mt-8 border border-rule bg-paper-2 p-5">
          {state.status === "decrypting" ? (
            <p className="text-sm">Decrypting protected note…</p>
          ) : (
            <div className="space-y-4">
              <div>
                <h2 className="text-sm font-bold uppercase tracking-wider">
                  Unlock protected note
                </h2>
                <p className="mt-1 text-sm text-ink-mute">
                  The encrypted body is unavailable until the vault identity is
                  unlocked in this browser session.
                </p>
              </div>
              {state.status === "error" ? (
                <p role="alert" className="text-sm text-hot">
                  ⁂ {state.error}
                </p>
              ) : null}
              {config.data?.wrapped_identity && !recoveryMode ? (
                <div className="space-y-2">
                  <label className="block">
                    <span className="cl-mono text-[9px] uppercase tracking-[0.16em] text-ink-mute">
                      Encryption password
                    </span>
                    <input
                      aria-label="Encryption password"
                      type="password"
                      value={password}
                      disabled={busy}
                      onChange={(event) => setPassword(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void unlockWithPassword();
                        }
                      }}
                      className="cl-mono mt-1 w-full border border-rule bg-paper p-2 text-[12px] outline-none focus:border-accent"
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="cl-btn cl-btn-hot"
                      disabled={busy || !password}
                      onClick={() => void unlockWithPassword()}
                    >
                      {busy ? "unlocking…" : "Unlock note"}
                    </button>
                    <button
                      type="button"
                      className="cl-btn"
                      disabled={busy}
                      onClick={() => setRecoveryMode(true)}
                    >
                      Use recovery identity
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <label className="block">
                    <span className="cl-mono text-[9px] uppercase tracking-[0.16em] text-ink-mute">
                      Recovery identity
                    </span>
                    <textarea
                      aria-label="Recovery identity"
                      value={recoveryIdentity}
                      disabled={busy}
                      rows={3}
                      spellCheck={false}
                      onChange={(event) =>
                        setRecoveryIdentity(event.target.value)
                      }
                      className="cl-mono mt-1 w-full resize-y border border-rule bg-paper p-2 text-[11px] outline-none focus:border-accent"
                    />
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="cl-btn cl-btn-hot"
                      disabled={busy || !recoveryIdentity.trim()}
                      onClick={() => void unlockWithRecovery()}
                    >
                      {busy ? "validating…" : "Import and unlock"}
                    </button>
                    {config.data?.wrapped_identity ? (
                      <button
                        type="button"
                        className="cl-btn"
                        disabled={busy}
                        onClick={() => setRecoveryMode(false)}
                      >
                        Use password
                      </button>
                    ) : null}
                  </div>
                </div>
              )}
              {error ? (
                <p
                  role="alert"
                  aria-live="assertive"
                  className="text-sm text-hot"
                >
                  ⁂ {error}
                </p>
              ) : null}
            </div>
          )}
        </section>
        {properties}
      </main>
    </div>
  );
}
