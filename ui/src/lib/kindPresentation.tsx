import type { ComponentType } from "react";
import type { components } from "#/api/schema";
import { AiJournalMeta, JournalMeta } from "#/components/codex/JournalMeta";
import { meetingIntake } from "#/components/codex/MeetingIntake";
import { MeetingMeta } from "#/components/codex/MeetingMeta";
import { PersonMeta } from "#/components/codex/PersonMeta";
import { TaskMeta } from "#/components/codex/TaskMeta";
import type { PageEditorState } from "#/editor/usePageEditor";
import { aiJournalDayLabel, journalDayLabel } from "#/lib/journal";
import type { Kind } from "#/lib/kind";

/** Props FOLIO hands every bespoke block, in the META rail or the header. */
export type KindExtrasProps = {
  path: string;
  /** Workspace tab hosting this folio — lets a block repoint it (day nav). */
  tabId: string;
  /** True while the editor drafts a not-yet-created page (today's journal). */
  isDraft: boolean;
  pageId?: string;
  readOnly?: boolean;
  beginMetadataChange?: PageEditorState["beginGeneratedChange"];
  onMoved?: (page: { path: string }) => void;
};

/** Kind-specific create fields, separate from the shared title/tags/filing. */
export type KindIntakeValues = Pick<
  components["schemas"]["CreatePageRequest"],
  "attendees" | "occurred_at"
>;

export type KindIntakeProps = {
  value: KindIntakeValues;
  onChange: (value: KindIntakeValues) => void;
};

export type KindIntakeDefinition = {
  Fields: ComponentType<KindIntakeProps>;
  initialValues: () => KindIntakeValues;
  serialize: (value: KindIntakeValues) => KindIntakeValues;
};

/** What a per-kind renderer may customise around the shared FOLIO editor. */
export type KindPresentation = {
  /** Optional fields collected by Inscribe before a page exists. */
  intake?: KindIntakeDefinition;
  /** Selects the shared body surface without coupling Folio to kind names. */
  bodyPresentation: "editor" | "ai-conversation" | "recipe";
  /** Extra META-rail block for this kind, or null for the generic surface. */
  metaExtras: ComponentType<KindExtrasProps> | null;
  /** Label for FOLIO's wrapping Block around metaExtras (default "Details"). */
  metaExtrasLabel?: string;
  /** Kind-specific facts rendered in the document column directly under the
   *  title/tags header (MEETING: occurred + attendees; PERSON: birthday), or null. */
  headerExtras: ComponentType<KindExtrasProps> | null;
  /** When set, FOLIO renders this string as a static title in place of the
   *  editable title input. */
  readOnlyTitle?: (path: string, title: string) => string;
};

const GENERIC: KindPresentation = {
  bodyPresentation: "editor",
  metaExtras: null,
  headerExtras: null,
};

/** Bespoke registry. A kind's extras land in the META rail when they are
 *  navigation or sidebar metadata (JOURNAL's day nav), and in the header when
 *  they are facts of the note itself (MEETING's occurred + attendees). */
const REGISTRY: Partial<Record<Kind, KindPresentation>> = {
  TASK: {
    bodyPresentation: "editor",
    metaExtras: null,
    headerExtras: TaskMeta,
  },
  RECIPE: {
    bodyPresentation: "recipe",
    metaExtras: null,
    headerExtras: null,
  },
  AI_CONVERSATION: {
    bodyPresentation: "ai-conversation",
    metaExtras: null,
    headerExtras: null,
  },
  JOURNAL: {
    bodyPresentation: "editor",
    metaExtras: JournalMeta,
    metaExtrasLabel: "Journal",
    headerExtras: null,
    readOnlyTitle: journalDayLabel,
  },
  AI_JOURNAL: {
    bodyPresentation: "editor",
    metaExtras: AiJournalMeta,
    metaExtrasLabel: "AI Journal",
    headerExtras: null,
    readOnlyTitle: aiJournalDayLabel,
  },
  MEETING: {
    intake: meetingIntake,
    bodyPresentation: "editor",
    metaExtras: null,
    headerExtras: MeetingMeta,
  },
  PERSON: {
    bodyPresentation: "editor",
    metaExtras: null,
    headerExtras: PersonMeta,
  },
};

export function presentationFor(kind: Kind): KindPresentation {
  return REGISTRY[kind] ?? GENERIC;
}
