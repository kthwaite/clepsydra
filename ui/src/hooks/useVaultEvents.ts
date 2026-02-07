import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

interface SyncNotification {
  type: "index_changed";
  upserted: string[];
  removed: string[];
}

export function useVaultEvents(): ConnectionStatus {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let disposed = false;

    function connect() {
      if (disposed) return;
      setStatus("connecting");
      es = new EventSource("/api/vault/events");

      es.onopen = () => {
        if (!disposed) setStatus("connected");
      };

      es.onmessage = (event) => {
        try {
          const data: SyncNotification = JSON.parse(event.data);
          if (data.type === "index_changed") {
            queryClient.invalidateQueries({ queryKey: ["pages"] });
            queryClient.invalidateQueries({ queryKey: ["index"] });
          }
        } catch {
          // ignore malformed events
        }
      };

      es.onerror = () => {
        if (disposed) return;
        setStatus("disconnected");
        es?.close();
        retryTimeoutRef.current = setTimeout(connect, 3000);
      };
    }

    connect();

    return () => {
      disposed = true;
      es?.close();
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    };
  }, [queryClient]);

  return status;
}
