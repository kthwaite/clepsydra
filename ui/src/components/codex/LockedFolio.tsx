import { Lock } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useEncryptionConfig } from "#/api/encryption";
import { Section } from "#/components/codex/Section";
import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";
import { useEncryptionActions } from "#/crypto/EncryptionProvider";
import type { DecryptedBodyState } from "#/editor/useDecryptedPageBody";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

type LockedFolioProps = {
  path: string;
  title: string;
  tags: string[];
  derivedTags?: string[];
  state: Exclude<DecryptedBodyState, { status: "plain" }>;
  properties?: ReactNode;
  pageActions?: ReactNode;
};

export function LockedFolio({
  path,
  title,
  tags,
  derivedTags = [],
  state,
  properties,
  pageActions,
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
      <main className="mx-auto grid max-w-[1040px] gap-10 px-7 pt-12 pb-16 lg:grid-cols-[232px_minmax(0,1fr)] lg:gap-x-16 lg:px-10 lg:pt-16">
        <header className="w-full min-w-0 max-w-[680px] justify-self-center lg:col-start-2 lg:row-start-1">
          <div className="flex items-center gap-2 text-[13px] text-mute">
            <Lock aria-hidden className="size-3.5" />
            <span>Protected folio</span>
          </div>
          <h1 className="mt-3.5 font-serif text-[clamp(44px,4.2vw,60px)] font-normal leading-[1.02] tracking-[-0.015em] text-ink">
            {title || path}
          </h1>
          <p className="mt-3.5 break-all text-[13px] text-mute">{path}</p>
          {tags.length > 0 ? (
            <section
              aria-label="Tags"
              className="mt-1.5 text-[13px] text-accent"
            >
              {tags.map((tag) => `#${tag}`).join(" ")}
            </section>
          ) : null}
          {derivedTags.length > 0 ? (
            <section
              aria-label="Read-only Tags"
              className="mt-1.5 text-[13px] text-accent"
            >
              {derivedTags.map((tag) => `#${tag}`).join(" ")}
            </section>
          ) : null}
        </header>

        {properties || pageActions ? (
          <aside className="flex min-w-0 flex-col gap-12 lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:pt-1.5">
            {properties}
            {pageActions ? (
              <Section label="Page actions" pip="dim" compact>
                {pageActions}
              </Section>
            ) : null}
          </aside>
        ) : null}

        <section className="w-full min-w-0 max-w-[680px] self-start justify-self-center rounded-2xl bg-raise px-6 pt-7 pb-8 md:px-8 lg:col-start-2 lg:row-start-2">
          {state.status === "decrypting" ? (
            <p className="text-[14.5px] text-mute">
              Decrypting protected note…
            </p>
          ) : (
            <div className="flex flex-col gap-5">
              <div>
                <div className="flex items-center gap-2.5">
                  <Tick />
                  <h2 className="font-serif text-[22px] font-normal italic leading-none text-ink">
                    Unlock protected note
                  </h2>
                </div>
                <p className="mt-2 pl-[17px] text-[14.5px] leading-[1.55] text-mute">
                  The encrypted body is unavailable until the vault identity is
                  unlocked in this browser session.
                </p>
              </div>
              <div className="flex flex-col gap-3.5 pl-[17px]">
                {state.status === "error" ? (
                  <p role="alert" className="text-[13.5px] text-hot">
                    {state.error}
                  </p>
                ) : null}
                {config.data?.wrapped_identity && !recoveryMode ? (
                  <>
                    <label className="flex flex-col gap-1.5">
                      <span className="text-[13px] text-mute">
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
                        className={cn(
                          "h-11 w-full shrink-0 rounded-[10px] bg-sink px-3.5 text-[15px] text-ink disabled:opacity-45",
                          FOCUS_RING_NATIVE,
                        )}
                      />
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="primary"
                        isDisabled={busy || !password}
                        onPress={() => void unlockWithPassword()}
                      >
                        {busy ? "Unlocking…" : "Unlock note"}
                      </Button>
                      <Button
                        variant="secondary"
                        isDisabled={busy}
                        onPress={() => setRecoveryMode(true)}
                      >
                        Use recovery identity
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <label className="flex flex-col gap-1.5">
                      <span className="text-[13px] text-mute">
                        Recovery identity
                      </span>
                      <textarea
                        aria-label="Recovery identity"
                        data-code-editor=""
                        value={recoveryIdentity}
                        disabled={busy}
                        rows={3}
                        spellCheck={false}
                        onChange={(event) =>
                          setRecoveryIdentity(event.target.value)
                        }
                        className={cn(
                          "w-full shrink-0 resize-y rounded-[10px] bg-sink px-3.5 py-3 text-[12.5px] leading-[1.55] text-ink disabled:opacity-45",
                          FOCUS_RING_NATIVE,
                        )}
                      />
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="primary"
                        isDisabled={busy || !recoveryIdentity.trim()}
                        onPress={() => void unlockWithRecovery()}
                      >
                        {busy ? "Validating…" : "Import and unlock"}
                      </Button>
                      {config.data?.wrapped_identity ? (
                        <Button
                          variant="secondary"
                          isDisabled={busy}
                          onPress={() => setRecoveryMode(false)}
                        >
                          Use password
                        </Button>
                      ) : null}
                    </div>
                  </>
                )}
                {error ? (
                  <p
                    role="alert"
                    aria-live="assertive"
                    className="text-[13.5px] text-hot"
                  >
                    {error}
                  </p>
                ) : null}
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
