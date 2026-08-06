import { useSyncExternalStore } from "react";
import type { refractor as refractorSingleton } from "refractor";

/** The registered refractor singleton's type (see refractor-languages.ts). */
export type Refractor = typeof refractorSingleton;

// The refractor grammar bundle is ~90 kB minified — a third of the editor
// chunk — so it stays out of the static import graph and loads on demand:
// the first time a decorate pass meets a highlighted code block, or when the
// language picker opens. This module owns that load-once state.

let instance: Refractor | null = null;
let loadPromise: Promise<Refractor> | null = null;
const listeners = new Set<() => void>();

/** Start (or join) the grammar-bundle load. Idempotent. */
export function loadRefractor(): Promise<Refractor> {
  loadPromise ??= import("#/editor/refractor-languages").then((m) => {
    instance = m.refractor;
    for (const listener of [...listeners]) listener();
    return m.refractor;
  });
  return loadPromise;
}

function getLoadedRefractor(): Refractor | null {
  return instance;
}

function subscribeRefractor(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The registered refractor singleton once its chunk has loaded, else null.
 * Subscribes the component so it re-renders when the bundle lands; does not
 * itself trigger the load (callers that want the grammars call
 * `loadRefractor`, or rely on a decorate pass doing so).
 */
export function useRefractor(): Refractor | null {
  return useSyncExternalStore(subscribeRefractor, getLoadedRefractor);
}
