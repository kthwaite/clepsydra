import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { clearBlockDetailsForPagePaths } from "#/api/blocks";
import { invalidateByPath, invalidateRubbish, queryKeys } from "#/api/keys";
import {
  type ConnectionStatus,
  emitIndexChanged,
  useConnectionStore,
} from "#/offline/connectionStore";

export type { ConnectionStatus } from "#/offline/connectionStore";

type SyncNotification =
  | {
      type: "index_changed";
      upserted: string[];
      removed: string[];
    }
  | { type: "base_registry_changed" }
  | { type: "feed_changed" };

export const SSE_BACKOFF = { initialMs: 3000, maxMs: 60_000, jitter: 0.2 };

/** Exponential backoff with ±jitter; `random` is injectable for tests. */
export function nextBackoffMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(
    SSE_BACKOFF.initialMs * 2 ** attempt,
    SSE_BACKOFF.maxMs,
  );
  const spread = (random() * 2 - 1) * SSE_BACKOFF.jitter;
  return Math.round(base * (1 + spread));
}

export function useVaultEvents(): ConnectionStatus {
  const queryClient = useQueryClient();
  const [status, setLocalStatus] = useState<ConnectionStatus>("connecting");
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const setStoreStatus = useConnectionStore((s) => s.setStatus);

  useEffect(() => {
    let es: EventSource | null = null;
    let disposed = false;
    let waitingForOnline = false;

    function setStatus(next: ConnectionStatus) {
      setLocalStatus(next);
      setStoreStatus(next);
    }

    function scheduleReconnect() {
      if (disposed) return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        waitingForOnline = true;
        return;
      }
      const delay = nextBackoffMs(attemptRef.current);
      attemptRef.current += 1;
      retryTimeoutRef.current = setTimeout(connect, delay);
    }

    function connect() {
      if (disposed) return;
      waitingForOnline = false;
      setStatus("connecting");
      es = new EventSource("/api/vault/events");

      es.onopen = () => {
        if (disposed) return;
        attemptRef.current = 0;
        setStatus("connected");
      };

      es.onmessage = (event) => {
        try {
          const data: SyncNotification = JSON.parse(event.data);
          if (data.type === "index_changed") {
            emitIndexChanged({
              upserted: data.upserted,
              removed: data.removed,
            });
            void clearBlockDetailsForPagePaths(queryClient, [
              ...data.upserted,
              ...data.removed,
            ]);
            invalidateByPath(queryClient, queryKeys.pages.pathPrefix);
            invalidateByPath(queryClient, queryKeys.folders.pathPrefix);
            invalidateByPath(queryClient, queryKeys.index.pathPrefix);
            invalidateByPath(queryClient, queryKeys.academic.pathPrefix);
            invalidateRubbish(queryClient);
            queryClient.invalidateQueries({ queryKey: queryKeys.blocks.all });
            queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
            queryClient.invalidateQueries({ queryKey: queryKeys.agenda.all });
            queryClient.invalidateQueries({ queryKey: queryKeys.board.all });
            // Page edits move rows in and out of base views (the Neovim case).
            invalidateByPath(queryClient, queryKeys.bases.pathPrefix);
            invalidateByPath(queryClient, queryKeys.query.pathPrefix);
            // A sync merge can add or remove Conflict Copies.
            queryClient.invalidateQueries({ queryKey: queryKeys.sync.prefix });
          }
          if (data.type === "base_registry_changed") {
            invalidateByPath(queryClient, queryKeys.bases.pathPrefix);
            invalidateByPath(queryClient, queryKeys.query.pathPrefix);
            queryClient.invalidateQueries({
              predicate: (query) =>
                query.queryKey[1] === queryKeys.pages.propertyProjectionPath,
            });
          }
          if (data.type === "feed_changed") {
            invalidateByPath(queryClient, queryKeys.feeds.pathPrefix);
          }
        } catch {
          // ignore malformed events
        }
      };

      es.onerror = () => {
        if (disposed) return;
        setStatus("disconnected");
        es?.close();
        scheduleReconnect();
      };
    }

    function onOnline() {
      if (disposed || !waitingForOnline) return;
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
      connect();
    }

    window.addEventListener("online", onOnline);
    connect();

    return () => {
      disposed = true;
      window.removeEventListener("online", onOnline);
      es?.close();
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
      // Leave the shared store neutral so an unmounting instance can't pin
      // it at "disconnected" forever (connectionStore's sticky-first-error
      // semantics would otherwise never clear disconnectedSince).
      setStoreStatus("connecting");
    };
  }, [queryClient, setStoreStatus]);

  return status;
}
