import { create } from "zustand";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

interface ConnectionState {
  status: ConnectionStatus;
  /** Epoch ms of the first error in the current disconnected stretch. */
  disconnectedSince: number | null;
  setStatus: (status: ConnectionStatus, now?: number) => void;
}

/**
 * The SSE stream's health, written by `useVaultEvents` and read by anything
 * that needs an online/offline answer without opening its own EventSource.
 */
export const useConnectionStore = create<ConnectionState>((set, get) => ({
  status: "connecting",
  disconnectedSince: null,
  setStatus: (status, now = Date.now()) => {
    if (status === "disconnected") {
      set({
        status,
        disconnectedSince: get().disconnectedSince ?? now,
      });
      return;
    }
    set({ status, disconnectedSince: null });
  },
}));

interface IndexDelta {
  upserted: string[];
  removed: string[];
}

type DeltaListener = (delta: IndexDelta) => void;
const deltaListeners = new Set<DeltaListener>();

/** Subscribe to SSE `index_changed` deltas (used by the offline walker). */
export function onIndexChanged(listener: DeltaListener): () => void {
  deltaListeners.add(listener);
  return () => deltaListeners.delete(listener);
}

export function emitIndexChanged(delta: IndexDelta) {
  for (const listener of deltaListeners) listener(delta);
}
