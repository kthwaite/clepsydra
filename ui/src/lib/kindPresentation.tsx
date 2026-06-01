import type { ComponentType } from "react";
import type { Kind } from "#/lib/kind";

/** What a per-kind renderer may customise around the shared FOLIO editor.
 *  v1 exposes a single slot; bespoke renderers (JOURNAL day-nav, BOOK biblio —
 *  the deferred "works" subsystem) slot in here later without touching FOLIO. */
export type KindPresentation = {
  /** Extra META-rail block for this kind, or null for the generic surface. */
  metaExtras: ComponentType<{ path: string }> | null;
};

const GENERIC: KindPresentation = { metaExtras: null };

/** Bespoke registry. Empty for now — every kind uses the generic surface.
 *  Add entries here (e.g. BOOK: { metaExtras: BookBiblioBlock }) to introduce
 *  a per-kind renderer. */
const REGISTRY: Partial<Record<Kind, KindPresentation>> = {};

export function presentationFor(kind: Kind): KindPresentation {
  return REGISTRY[kind] ?? GENERIC;
}
