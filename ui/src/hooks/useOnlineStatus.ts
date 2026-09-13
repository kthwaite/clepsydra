import { useEffect, useState, useSyncExternalStore } from "react";
import {
  type ConnectionStatus,
  useConnectionStore,
} from "#/offline/connectionStore";

export const SSE_DISCONNECT_GRACE_MS = 10_000;

export function computeOnline(input: {
  navigatorOnline: boolean;
  status: ConnectionStatus;
  disconnectedSince: number | null;
  now: number;
}): boolean {
  if (!input.navigatorOnline) return false;
  if (input.status !== "disconnected" || input.disconnectedSince === null) {
    return true;
  }
  return input.now - input.disconnectedSince < SSE_DISCONNECT_GRACE_MS;
}

function subscribeNavigator(notify: () => void) {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
}

function readNavigatorOnline() {
  return typeof navigator === "undefined" ? true : navigator.onLine !== false;
}

/** True when the browser is online and the SSE stream is healthy (10 s grace). */
export function useOnlineStatus(): boolean {
  const navigatorOnline = useSyncExternalStore(
    subscribeNavigator,
    readNavigatorOnline,
    () => true,
  );
  const status = useConnectionStore((s) => s.status);
  const disconnectedSince = useConnectionStore((s) => s.disconnectedSince);
  const [now, setNow] = useState(() => Date.now());

  // Re-evaluate once the grace period would expire.
  useEffect(() => {
    if (status !== "disconnected" || disconnectedSince === null) return;
    const remaining = disconnectedSince + SSE_DISCONNECT_GRACE_MS - Date.now();
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, remaining) + 1,
    );
    return () => clearTimeout(timer);
  }, [status, disconnectedSince]);

  return computeOnline({
    navigatorOnline,
    status,
    disconnectedSince,
    now: Math.max(now, Date.now()),
  });
}
