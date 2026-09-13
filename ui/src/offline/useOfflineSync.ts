import { useEffect, useRef } from "react";
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
 *
 * The controller is built inside the mount effect itself, not via `useMemo`.
 * React StrictMode double-invokes effects (mount -> cleanup -> remount)
 * against the *same* memoized value, so a `useMemo`-owned controller would
 * be disposed by the fake cleanup and then reused, permanently dead, by the
 * fake remount (`OfflineSyncController.dispose()` is a one-way flag).
 * Constructing fresh inside the effect means the remount gets a brand new,
 * live instance; `controllerRef` lets `syncNow` and the online-transition
 * effect always reach whichever instance is currently mounted.
 */
export function useOfflineSync(): { syncNow: () => void } {
  const online = useOnlineStatus();
  const controllerRef = useRef<OfflineSyncController | null>(null);

  useEffect(() => {
    const controller = new OfflineSyncController({
      caches: globalThis.caches,
      now: () => Date.now(),
      isOnline: isOnlineNow,
    });
    controllerRef.current = controller;
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
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, []);

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
      controllerRef.current?.requestFull();
    }
  }, [online]);

  return { syncNow: () => controllerRef.current?.requestFull() };
}
