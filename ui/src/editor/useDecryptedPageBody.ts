import { useEffect, useReducer, useRef } from "react";
import type { PageDetail } from "#/api/types";
import { decryptMarkdown } from "#/crypto/age";
import type { EncryptionActions } from "#/crypto/EncryptionProvider";

export type DecryptedBodyState =
  | { status: "plain"; body: string }
  | { status: "locked" }
  | { status: "decrypting" }
  | { status: "error"; error: string };

type CachedDecryption = {
  key: string;
  identity: string;
  promise: Promise<string>;
  result?: DecryptedBodyState;
};

const LOCKED: DecryptedBodyState = { status: "locked" };
const DECRYPTING: DecryptedBodyState = { status: "decrypting" };

/**
 * Decrypts only into memory owned by the mounted folio. The API page remains
 * ciphertext and no plaintext is published to a query or persistent cache.
 */
export function useDecryptedPageBody(
  page: PageDetail | undefined,
  actions: EncryptionActions | null,
  lockEpoch: number,
): DecryptedBodyState {
  const cacheRef = useRef<CachedDecryption | null>(null);
  const [, publishResult] = useReducer((revision: number) => revision + 1, 0);
  const encrypted = page?.encrypted === true;
  const identity = encrypted ? (actions?.getIdentity() ?? null) : null;
  const ciphertext = page?.body ?? "";
  const decryptionKey =
    encrypted && page
      ? `${page.path}\u0000${page.revision}\u0000${lockEpoch}`
      : null;

  useEffect(() => {
    if (!encrypted || !page || !identity || !decryptionKey) {
      cacheRef.current = null;
      return;
    }

    let cached = cacheRef.current;
    if (
      !cached ||
      cached.key !== decryptionKey ||
      cached.identity !== identity
    ) {
      cached = {
        key: decryptionKey,
        identity,
        promise: decryptMarkdown(ciphertext, identity),
      };
      cacheRef.current = cached;
    }

    let active = true;
    const current = cached;
    void current.promise.then(
      (body) => {
        if (!active || cacheRef.current !== current) return;
        current.result = { status: "plain", body };
        publishResult();
      },
      () => {
        if (!active || cacheRef.current !== current) return;
        current.result = {
          status: "error",
          error: "Unable to authenticate encrypted note.",
        };
        publishResult();
      },
    );

    return () => {
      active = false;
    };
  }, [ciphertext, decryptionKey, encrypted, identity]);

  if (!page || !encrypted) {
    return { status: "plain", body: page?.body ?? "" };
  }
  if (!identity || !decryptionKey) return LOCKED;
  const cached = cacheRef.current;
  if (
    cached?.key === decryptionKey &&
    cached.identity === identity &&
    cached.result
  ) {
    return cached.result;
  }
  return DECRYPTING;
}
