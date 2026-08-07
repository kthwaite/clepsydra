import type { ComponentType } from "react";
import { JournalMeta } from "#/components/codex/JournalMeta";
import { journalDayLabel } from "#/lib/journal";
import type { Kind } from "#/lib/kind";

/** Props FOLIO hands every bespoke META-rail block. */
export type KindMetaExtrasProps = {
  path: string;
  /** Workspace tab hosting this folio — lets a block repoint it (day nav). */
  tabId: string;
  /** True while the editor drafts a not-yet-created page (today's journal). */
  isDraft: boolean;
};

/** What a per-kind renderer may customise around the shared FOLIO editor. */
export type KindPresentation = {
  /** Extra META-rail block for this kind, or null for the generic surface. */
  metaExtras: ComponentType<KindMetaExtrasProps> | null;
  /** Label for FOLIO's wrapping Block around metaExtras (default "Details"). */
  metaExtrasLabel?: string;
  /** When set, FOLIO renders this string as a static title in place of the
   *  editable title input. */
  readOnlyTitle?: (path: string, title: string) => string;
};

const GENERIC: KindPresentation = { metaExtras: null };

/** Bespoke registry. JOURNAL's metaExtras lands with the JournalMeta block. */
const REGISTRY: Partial<Record<Kind, KindPresentation>> = {
  JOURNAL: {
    metaExtras: JournalMeta,
    metaExtrasLabel: "Journal",
    readOnlyTitle: journalDayLabel,
  },
};

export function presentationFor(kind: Kind): KindPresentation {
  return REGISTRY[kind] ?? GENERIC;
}
