import type { ComponentType } from "react";
import { AiJournalMeta, JournalMeta } from "#/components/codex/JournalMeta";
import { MeetingMeta } from "#/components/codex/MeetingMeta";
import { aiJournalDayLabel, journalDayLabel } from "#/lib/journal";
import type { Kind } from "#/lib/kind";

/** Props FOLIO hands every bespoke META-rail block. */
export type KindMetaExtrasProps = {
  path: string;
  /** Workspace tab hosting this folio — lets a block repoint it (day nav). */
  tabId: string;
  /** True while the editor drafts a not-yet-created page (today's journal). */
  isDraft: boolean;
  /** The page's editable tags — the same values the folio header edits. */
  tags: string[];
  /** Replace the editable tags; the editor saves the way the header does. */
  onTagsChange: (next: string[]) => void;
};

/** What a per-kind renderer may customise around the shared FOLIO editor. */
export type KindPresentation = {
  /** Selects the shared body surface without coupling Folio to kind names. */
  bodyPresentation: "editor" | "ai-conversation" | "recipe";
  /** Extra META-rail block for this kind, or null for the generic surface. */
  metaExtras: ComponentType<KindMetaExtrasProps> | null;
  /** Label for FOLIO's wrapping Block around metaExtras (default "Details"). */
  metaExtrasLabel?: string;
  /** When set, FOLIO renders this string as a static title in place of the
   *  editable title input. */
  readOnlyTitle?: (path: string, title: string) => string;
};

const GENERIC: KindPresentation = {
  bodyPresentation: "editor",
  metaExtras: null,
};

/** Bespoke registry. JOURNAL's metaExtras lands with the JournalMeta block. */
const REGISTRY: Partial<Record<Kind, KindPresentation>> = {
  RECIPE: {
    bodyPresentation: "recipe",
    metaExtras: null,
  },
  AI_CONVERSATION: {
    bodyPresentation: "ai-conversation",
    metaExtras: null,
  },
  JOURNAL: {
    bodyPresentation: "editor",
    metaExtras: JournalMeta,
    metaExtrasLabel: "Journal",
    readOnlyTitle: journalDayLabel,
  },
  AI_JOURNAL: {
    bodyPresentation: "editor",
    metaExtras: AiJournalMeta,
    metaExtrasLabel: "AI Journal",
    readOnlyTitle: aiJournalDayLabel,
  },
  MEETING: {
    bodyPresentation: "editor",
    metaExtras: MeetingMeta,
    metaExtrasLabel: "Meeting",
  },
};

export function presentationFor(kind: Kind): KindPresentation {
  return REGISTRY[kind] ?? GENERIC;
}
