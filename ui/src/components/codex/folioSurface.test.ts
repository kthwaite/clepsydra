import { describe, expect, it } from "vitest";
import {
  type FolioSurfaceInput,
  type FolioSurfaceResolution,
  resolveFolioSurface,
} from "./folioSurface";

const BASE: FolioSurfaceInput = {
  bodyPresentation: "editor",
  conversationMode: "read",
  recipeMode: "read",
  recipeStructured: false,
  recipeHasBlockIds: false,
  isLoading: false,
  error: false,
  isDraft: false,
  offline: false,
  readonly: false,
  generatedChangePending: false,
  encrypted: false,
  encryptionStatus: "plain",
  journalTodayPending: false,
  rawSessionOpen: false,
};

const CONVERSATION: Partial<FolioSurfaceInput> = {
  bodyPresentation: "ai-conversation",
};
const RECIPE: Partial<FolioSurfaceInput> = {
  bodyPresentation: "recipe",
  recipeStructured: true,
};

type Row = [
  name: string,
  input: Partial<FolioSurfaceInput>,
  expected: Partial<FolioSurfaceResolution>,
];

// Pins the expressions Folio used before the resolver existed: folioReadOnly,
// the Slate readOnly prop, rawMarkdownAvailable, restorationAvailable and the
// early-return / body branch order.
const ROWS: Row[] = [
  [
    "editor note",
    {},
    {
      surface: "editor",
      readOnly: false,
      bodyReadOnly: false,
      rawAvailable: true,
      contentAvailable: true,
      locked: false,
    },
  ],
  [
    "editor note while loading",
    { isLoading: true },
    { surface: "loading", rawAvailable: false, contentAvailable: false },
  ],
  [
    "editor note that failed to load",
    { error: true },
    { surface: "error", rawAvailable: false, contentAvailable: false },
  ],
  [
    "loading wins over a load error",
    { isLoading: true, error: true },
    { surface: "loading" },
  ],
  [
    "draft with a load error still edits",
    { error: true, isDraft: true },
    { surface: "editor", rawAvailable: true, contentAvailable: true },
  ],
  [
    "offline note",
    { offline: true },
    {
      surface: "editor",
      offlineReadOnly: true,
      bodyProtected: false,
      readOnly: true,
      bodyReadOnly: true,
      rawAvailable: false,
      contentAvailable: true,
    },
  ],
  [
    "protected (archived) note keeps raw mode",
    { readonly: true },
    {
      bodyProtected: true,
      readOnly: true,
      bodyReadOnly: true,
      rawAvailable: true,
    },
  ],
  [
    "offline overrides protection",
    { readonly: true, offline: true },
    { bodyProtected: false, offlineReadOnly: true, readOnly: true },
  ],
  [
    "protected note during a generated change",
    { readonly: true, generatedChangePending: true },
    { bodyProtected: false, readOnly: false, bodyReadOnly: true },
  ],
  [
    "generated change only locks the body",
    { generatedChangePending: true },
    { readOnly: false, bodyReadOnly: true, rawAvailable: true },
  ],
  [
    "locked encrypted note",
    { encrypted: true, encryptionStatus: "locked" },
    {
      surface: "locked",
      locked: true,
      rawAvailable: false,
      contentAvailable: false,
    },
  ],
  [
    "decrypting note",
    { encrypted: true, encryptionStatus: "decrypting" },
    { surface: "locked", locked: true },
  ],
  [
    "unlocked encrypted note",
    { encrypted: true, encryptionStatus: "plain" },
    {
      surface: "editor",
      locked: false,
      rawAvailable: true,
      contentAvailable: true,
    },
  ],
  [
    "today's journal still resolving",
    { journalTodayPending: true },
    { surface: "journal-today", rawAvailable: false, contentAvailable: true },
  ],
  [
    "today's journal wins over loading",
    { journalTodayPending: true, isLoading: true },
    { surface: "journal-today" },
  ],
  [
    "open raw session",
    { rawSessionOpen: true },
    { surface: "raw-markdown", rawAvailable: true },
  ],
  [
    "open raw session survives loading",
    { rawSessionOpen: true, isLoading: true },
    { surface: "raw-markdown", rawAvailable: false },
  ],
  [
    "open raw session survives a lock",
    { rawSessionOpen: true, encrypted: true, encryptionStatus: "locked" },
    { surface: "raw-markdown", rawAvailable: false },
  ],
  [
    "open raw session survives today's journal",
    { rawSessionOpen: true, journalTodayPending: true },
    { surface: "raw-markdown", rawAvailable: false },
  ],
  [
    "conversation in read mode",
    CONVERSATION,
    {
      surface: "editor",
      isAiConversation: true,
      conversationReadOnly: true,
      readOnly: true,
      bodyReadOnly: true,
      rawAvailable: false,
    },
  ],
  [
    "conversation in edit mode",
    { ...CONVERSATION, conversationMode: "edit" },
    {
      surface: "editor",
      conversationReadOnly: false,
      readOnly: false,
      bodyReadOnly: false,
      rawAvailable: true,
    },
  ],
  [
    "conversation in edit mode offline",
    { ...CONVERSATION, conversationMode: "edit", offline: true },
    { readOnly: true, rawAvailable: false },
  ],
  [
    "structured recipe in read mode",
    RECIPE,
    {
      surface: "recipe",
      isRecipe: true,
      recipePresentationStructured: true,
      readOnly: true,
      bodyReadOnly: false,
      rawAvailable: false,
    },
  ],
  [
    "structured recipe in edit mode",
    { ...RECIPE, recipeMode: "edit" },
    {
      surface: "recipe",
      recipePresentationStructured: true,
      readOnly: false,
      rawAvailable: true,
    },
  ],
  [
    "structured recipe with block ids falls back to the editor",
    { ...RECIPE, recipeHasBlockIds: true },
    {
      surface: "editor",
      recipePresentationStructured: false,
      readOnly: false,
      rawAvailable: true,
    },
  ],
  [
    "unstructured recipe in read mode",
    { ...RECIPE, recipeStructured: false },
    {
      surface: "editor",
      recipePresentationStructured: false,
      readOnly: false,
      rawAvailable: false,
    },
  ],
  [
    "unstructured recipe in edit mode",
    { ...RECIPE, recipeStructured: false, recipeMode: "edit" },
    { surface: "editor", rawAvailable: false },
  ],
  [
    "structured recipe with an open raw session",
    { ...RECIPE, recipeMode: "edit", rawSessionOpen: true },
    { surface: "raw-markdown", rawAvailable: true },
  ],
  [
    "structured recipe in read mode while protected",
    { ...RECIPE, readonly: true },
    { surface: "recipe", readOnly: true, bodyReadOnly: true },
  ],
  [
    "editor kind ignores conversation and recipe modes",
    { conversationMode: "edit", recipeMode: "edit", recipeStructured: true },
    {
      surface: "editor",
      isAiConversation: false,
      isRecipe: false,
      conversationReadOnly: false,
      recipePresentationStructured: false,
      readOnly: false,
      rawAvailable: true,
    },
  ],
];

describe("resolveFolioSurface", () => {
  it.each(ROWS)("%s", (_name, input, expected) => {
    expect(resolveFolioSurface({ ...BASE, ...input })).toMatchObject(expected);
  });
});
