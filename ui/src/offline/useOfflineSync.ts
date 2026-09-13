import { useEffect, useMemo, useRef } from "react";
import { computeOnline, useOnlineStatus } from "#/hooks/useOnlineStatus";
import { onIndexChanged, useConnectionStore } from "#/offline/connectionStore";
import { useOfflineStore } from "#/offline/offlineStore";
import {
  FULL_SYNC_MAX_AGE_MS,
  LAUNCH_DELAY_MS,
  OfflineSyncController,
} from "#/offline/sync";

let activeController: OfflineSyncController | null = null;

/** Settings "Sync now" reaches the mounted controller through this. */
export function requestOfflineSyncNow() {
  activeController?.requestFull();
}

function isOnlineNow(): boolean {
  const { status, disconnectedSince } = useConnectionStore.getState();
  return computeOnline({
    navigatorOnline:
      typeof navigator === "undefined" ? true : navigator.onLine !== false,
    status,
    disconnectedSince,
    now: Date.now(),
  });
}

function copyIsStale(lastFullSync: string | null): boolean {
  if (!lastFullSync) return true;
  return Date.now() - Date.parse(lastFullSync) > FULL_SYNC_MAX_AGE_MS;
}

/**
 * Mount once (root route). Owns the walker controller for the page session:
 * launch pass, SSE deltas, and the shared "sync now" entry point.
 */
export function useOfflineSync(): { syncNow: () => void } {
  const online = useOnlineStatus();
  const controller = useMemo(
    () =>
      new OfflineSyncController({
        caches: globalThis.caches,
        now: () => Date.now(),
        isOnline: isOnlineNow,
      }),
    [],
  );

  useEffect(() => {
    activeController = controller;
    const offDelta = onIndexChanged((delta) => controller.requestDelta(delta));
    const launch = setTimeout(() => {
      if (copyIsStale(useOfflineStore.getState().lastFullSync)) {
        controller.requestFull();
      }
    }, LAUNCH_DELAY_MS);
    return () => {
      clearTimeout(launch);
      offDelta();
      controller.dispose();
      if (activeController === controller) activeController = null;
    };
  }, [controller]);

  // Coming back online after a stale stretch: refresh the copy. Tracks the
  // previous value so this fires on a genuine offline->online transition,
  // not on the initial mount (the launch effect above already owns that).
  const wasOnline = useRef(online);
  useEffect(() => {
    const cameBackOnline = online && !wasOnline.current;
    wasOnline.current = online;
    if (
      cameBackOnline &&
      copyIsStale(useOfflineStore.getState().lastFullSync)
    ) {
      controller.requestFull();
    }
  }, [online, controller]);

  return { syncNow: () => controller.requestFull() };
}
