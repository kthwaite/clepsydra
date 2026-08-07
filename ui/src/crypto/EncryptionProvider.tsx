import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useEncryptionConfig } from "#/api/encryption";
import { EncryptionSession } from "./session";

export type EncryptionStatus = {
  status: "loading" | "locked" | "unlocked";
  keyId: string | null;
  error: string | null;
  lockEpoch: number;
};

export type EditorFlusher = () => void | Promise<void>;

export type EncryptionActions = {
  unlockWithPassword(password: string): Promise<void>;
  unlockWithImportedIdentity(identity: string): Promise<void>;
  getIdentity(): string | null;
  lock(): Promise<boolean>;
  registerFlusher(flusher: EditorFlusher): () => void;
};

type EncryptionProviderProps = {
  children: ReactNode;
  idleTimeoutMs?: number | null;
};

const StatusContext = createContext<EncryptionStatus | null>(null);
const ActionsContext = createContext<EncryptionActions | null>(null);

export function useEncryptionStatus(): EncryptionStatus {
  const status = useContext(StatusContext);
  if (!status) {
    throw new Error(
      "useEncryptionStatus must be used within EncryptionProvider",
    );
  }
  return status;
}

export function useOptionalEncryptionStatus(): EncryptionStatus | null {
  return useContext(StatusContext);
}

export function useEncryptionActions(): EncryptionActions {
  const actions = useContext(ActionsContext);
  if (!actions) {
    throw new Error(
      "useEncryptionActions must be used within EncryptionProvider",
    );
  }
  return actions;
}

export function useOptionalEncryptionActions(): EncryptionActions | null {
  return useContext(ActionsContext);
}

export function EncryptionProvider({
  children,
  idleTimeoutMs = null,
}: EncryptionProviderProps) {
  const config = useEncryptionConfig();
  const sessionRef = useRef<EncryptionSession | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = new EncryptionSession();
  }
  const configRef = useRef<{
    keyId: string | null;
    wrappedIdentity: string | null;
  }>({ keyId: null, wrappedIdentity: null });
  const flushersRef = useRef(new Set<EditorFlusher>());
  const lockingRef = useRef<Promise<boolean> | null>(null);
  const [status, setStatus] = useState<EncryptionStatus>({
    status: "loading",
    keyId: null,
    error: null,
    lockEpoch: 0,
  });

  const keyId = config.data?.key_id ?? null;
  const wrappedIdentity = config.data?.wrapped_identity ?? null;
  const configError = config.error
    ? "Unable to load encryption settings."
    : null;

  useEffect(() => {
    configRef.current = { keyId, wrappedIdentity };
    setStatus((previous) => {
      if (config.isPending) {
        if (
          previous.status === "loading" &&
          previous.keyId === keyId &&
          previous.error === null
        ) {
          return previous;
        }
        return { ...previous, status: "loading", keyId, error: null };
      }
      if (previous.status === "unlocked" && previous.keyId === keyId) {
        return configError === previous.error
          ? previous
          : { ...previous, error: configError };
      }
      const nextStatus: EncryptionStatus = {
        ...previous,
        status: "locked",
        keyId,
        error: configError,
      };
      return previous.status === nextStatus.status &&
        previous.keyId === nextStatus.keyId &&
        previous.error === nextStatus.error
        ? previous
        : nextStatus;
    });
  }, [config.isPending, configError, keyId, wrappedIdentity]);

  useEffect(
    () => () => {
      sessionRef.current?.clear();
    },
    [],
  );

  const actions = useMemo<EncryptionActions>(() => {
    const setUnlockError = (message: string) => {
      setStatus((previous) => ({
        ...previous,
        status: "locked",
        error: message,
      }));
    };

    const lock = (): Promise<boolean> => {
      if (lockingRef.current) {
        return lockingRef.current;
      }
      const pending = (async () => {
        if (!sessionRef.current?.getIdentity()) {
          setStatus((previous) =>
            previous.status === "locked" && previous.error === null
              ? previous
              : { ...previous, status: "locked", error: null },
          );
          return true;
        }
        try {
          await Promise.all(
            Array.from(flushersRef.current, (flush) =>
              Promise.resolve().then(flush),
            ),
          );
          sessionRef.current.clear();
          setStatus((previous) => ({
            ...previous,
            status: "locked",
            error: null,
            lockEpoch: previous.lockEpoch + 1,
          }));
          return true;
        } catch {
          setStatus((previous) => ({
            ...previous,
            status: "unlocked",
            error: "Unable to lock while an editor has unsaved changes.",
          }));
          return false;
        }
      })().finally(() => {
        lockingRef.current = null;
      });
      lockingRef.current = pending;
      return pending;
    };

    return {
      async unlockWithPassword(password) {
        const { keyId: currentKeyId, wrappedIdentity: currentWrappedIdentity } =
          configRef.current;
        if (!currentWrappedIdentity) {
          const message =
            "No wrapped identity is available for password unlock.";
          setUnlockError(message);
          throw new Error(message);
        }
        try {
          await sessionRef.current?.unlockWithPassword(
            currentWrappedIdentity,
            password,
          );
          setStatus((previous) => ({
            ...previous,
            status: "unlocked",
            keyId: currentKeyId,
            error: null,
          }));
        } catch {
          const message = "Unable to unlock the vault identity.";
          setUnlockError(message);
          throw new Error(message);
        }
      },
      async unlockWithImportedIdentity(identity) {
        try {
          await sessionRef.current?.unlockWithImportedIdentity(identity);
          setStatus((previous) => ({
            ...previous,
            status: "unlocked",
            keyId: configRef.current.keyId,
            error: null,
          }));
        } catch {
          const message = "Unable to import the vault identity.";
          setUnlockError(message);
          throw new Error(message);
        }
      },
      getIdentity() {
        return sessionRef.current?.getIdentity() ?? null;
      },
      lock,
      registerFlusher(flusher) {
        flushersRef.current.add(flusher);
        return () => {
          flushersRef.current.delete(flusher);
        };
      },
    };
  }, []);

  useEffect(() => {
    if (idleTimeoutMs === null || idleTimeoutMs <= 0) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const armTimer = () => {
      clearTimer();
      timer = setTimeout(() => {
        void actions.lock();
      }, idleTimeoutMs);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        clearTimer();
        void actions.lock();
      } else {
        armTimer();
      }
    };

    window.addEventListener("pointerdown", armTimer, { passive: true });
    window.addEventListener("keydown", armTimer);
    document.addEventListener("visibilitychange", handleVisibility);
    armTimer();
    return () => {
      clearTimer();
      window.removeEventListener("pointerdown", armTimer);
      window.removeEventListener("keydown", armTimer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [actions, idleTimeoutMs]);

  return (
    <ActionsContext value={actions}>
      <StatusContext value={status}>{children}</StatusContext>
    </ActionsContext>
  );
}
