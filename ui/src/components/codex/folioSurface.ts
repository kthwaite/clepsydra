import type { DecryptedBodyState } from "#/editor/useDecryptedPageBody";
import type { KindPresentation } from "#/lib/kindPresentation";

export type FolioMode = "read" | "edit";

export type FolioSurfaceInput = {
  bodyPresentation: KindPresentation["bodyPresentation"];
  conversationMode: FolioMode;
  recipeMode: FolioMode;
  /** The active recipe parse succeeded. */
  recipeStructured: boolean;
  /** The recipe body carries block ids, which the structured view would drop. */
  recipeHasBlockIds: boolean;
  isLoading: boolean;
  error: boolean;
  isDraft: boolean;
  offline: boolean;
  readonly: boolean;
  generatedChangePending: boolean;
  encrypted: boolean;
  encryptionStatus: DecryptedBodyState["status"];
  /** Today's journal (or AI journal) path is still resolving or redirecting. */
  journalTodayPending: boolean;
  rawSessionOpen: boolean;
};

/** What the Folio renders in place of, or as, its document body. */
export type FolioSurface =
  | "journal-today"
  | "loading"
  | "error"
  | "locked"
  | "raw-markdown"
  | "recipe"
  | "editor";

export type FolioSurfaceResolution = {
  surface: FolioSurface;
  isAiConversation: boolean;
  isRecipe: boolean;
  conversationReadOnly: boolean;
  /** The recipe renders as the structured recipe view. */
  recipePresentationStructured: boolean;
  offlineReadOnly: boolean;
  /** The server refuses body writes until the reader unlocks the page. */
  bodyProtected: boolean;
  /** An encrypted page whose body is not decrypted. */
  locked: boolean;
  /** The whole Folio is read-only: header, rails and body. */
  readOnly: boolean;
  /** The Slate body refuses edits. */
  bodyReadOnly: boolean;
  /** The page loaded and its content is visible. */
  contentAvailable: boolean;
  /** Raw Markdown mode may open or apply. */
  rawAvailable: boolean;
};

export function resolveFolioSurface(
  input: FolioSurfaceInput,
): FolioSurfaceResolution {
  const isAiConversation = input.bodyPresentation === "ai-conversation";
  const isRecipe = input.bodyPresentation === "recipe";
  const conversationReadOnly =
    isAiConversation && input.conversationMode === "read";
  const recipePresentationStructured =
    isRecipe && input.recipeStructured && !input.recipeHasBlockIds;
  const recipeReadOnly =
    recipePresentationStructured && input.recipeMode === "read";
  // Archived bodies are generated from a captured snapshot, and the page's
  // frontmatter hash claims to describe them; the server refuses body writes
  // until the reader explicitly unlocks the page.
  const offlineReadOnly = input.offline;
  const bodyProtected =
    input.readonly && !offlineReadOnly && !input.generatedChangePending;
  const locked = input.encrypted && input.encryptionStatus !== "plain";
  const failed = input.error && !input.isDraft;
  const contentAvailable = !input.isLoading && !failed && !locked;
  const rawPresentationAvailable =
    input.bodyPresentation === "editor" ||
    (isAiConversation && input.conversationMode === "edit") ||
    (isRecipe &&
      input.recipeStructured &&
      (input.recipeHasBlockIds || input.recipeMode === "edit"));

  return {
    surface: resolveSurface(
      input,
      failed,
      locked,
      recipePresentationStructured,
    ),
    isAiConversation,
    isRecipe,
    conversationReadOnly,
    recipePresentationStructured,
    offlineReadOnly,
    bodyProtected,
    locked,
    readOnly:
      conversationReadOnly ||
      recipeReadOnly ||
      bodyProtected ||
      offlineReadOnly,
    bodyReadOnly:
      conversationReadOnly ||
      bodyProtected ||
      offlineReadOnly ||
      input.generatedChangePending,
    contentAvailable,
    rawAvailable:
      rawPresentationAvailable &&
      contentAvailable &&
      !offlineReadOnly &&
      !input.journalTodayPending,
  };
}

function resolveSurface(
  input: FolioSurfaceInput,
  failed: boolean,
  locked: boolean,
  recipePresentationStructured: boolean,
): FolioSurface {
  // An open raw session outlives every blocking state so its draft survives.
  if (input.rawSessionOpen) return "raw-markdown";
  if (input.journalTodayPending) return "journal-today";
  if (input.isLoading) return "loading";
  if (failed) return "error";
  if (locked) return "locked";
  return recipePresentationStructured ? "recipe" : "editor";
}
