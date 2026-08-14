import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Descendant, Editor } from "slate";
import { usePage, useUpdatePage } from "#/api/pages";
import type { ApiError, PageMeta } from "#/api/types";
import {
  decryptMarkdown,
  encryptMarkdown,
  recipientForIdentity,
} from "#/crypto/age";
import {
  useOptionalEncryptionActions,
  useOptionalEncryptionStatus,
} from "#/crypto/EncryptionProvider";
import { markdownToSlate, slateToMarkdown } from "./convert";
import {
  type DecryptedBodyState,
  useDecryptedPageBody,
} from "./useDecryptedPageBody";

export type SaveStatus = "saved" | "saving" | "unsaved" | "error";

const DEBOUNCE_MS = 1500;

export interface RevisionConflict {
  currentRevision: string;
}

function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    typeof value.status === "number" &&
    "error" in value &&
    typeof value.error === "string"
  );
}

function decodeRevisionConflict(value: unknown): RevisionConflict | null {
  const apiError = isApiError(value) ? value : null;
  if (
    apiError?.status !== 409 ||
    typeof apiError.detail !== "object" ||
    apiError.detail === null ||
    !("code" in apiError.detail) ||
    apiError.detail.code !== "revision_conflict" ||
    !("current_revision" in apiError.detail) ||
    typeof apiError.detail.current_revision !== "string"
  ) {
    return null;
  }
  return { currentRevision: apiError.detail.current_revision };
}

export interface EnsuredPage {
  path: string;
  revision: string;
  body: string;
  meta: {
    title?: string | null;
    tags?: string[] | null;
    aliases?: string[] | null;
  };
}

export interface EnsureResult {
  page: EnsuredPage;
  created: boolean;
}

export interface PageEditorOptions {
  /** Create the page on the first save when it does not exist yet. */
  ensure?: () => Promise<EnsureResult>;
}

interface PageEditorState {
  isLoading: boolean;
  error: unknown;
  /** True when the page query settled on a 404 — the one case where an error
   *  genuinely means the file is missing, rather than a transient failure. */
  pageNotFound: boolean;
  isDraft: boolean;
  initialValue: Descendant[];
  /** Latest live Slate AST, including edits that have not saved yet. */
  editorValue: Descendant[];
  editorRevision: number;
  /** True once the Slate value for the current page revision is committed. */
  isEditorSynchronized: boolean;
  title: string;
  setTitle: (t: string) => void;
  tags: string[];
  computedTags: string[];
  setTags: (t: string[]) => void;
  aliases: string[];
  setAliases: (a: string[]) => void;
  saveStatus: SaveStatus;
  saveError: string | null;
  onSlateChange: (value: Descendant[], editor: Editor) => void;
  setBodyMarkdown: (markdown: string) => void;
  saveNow: () => Promise<void>;
  revisionConflict: RevisionConflict | null;
  reloadAfterConflict: () => Promise<void>;
  createdAt: string | null;
  updatedAt: string | null;
  archive: NonNullable<PageMeta["archive"]> | null;
  bodyMarkdown: string;
  kind: string | null;
  conversationProvider: string | null;
  inferred: boolean;
  /** Effective body write-protection, resolved by the server from the page's
   *  `readonly` or, absent that, its kind's default. */
  readonly: boolean;
  /** Declare or clear that protection. */
  setReadonly: (readonly: boolean) => Promise<void>;
  project: string | null;
  encryptionState: DecryptedBodyState;
  pageId: string | null;
  encrypted: boolean;
  getPlaintext: () => string;
  getRevision: () => string;
}

export function usePageEditor(
  path: string,
  options?: PageEditorOptions,
): PageEditorState {
  const { data: page, isLoading, error, refetch: refetchPage } = usePage(path);
  const encryptionStatus = useOptionalEncryptionStatus();
  const encryptionActions = useOptionalEncryptionActions();
  const lockEpoch = encryptionStatus?.lockEpoch ?? 0;
  const encryptionState = useDecryptedPageBody(
    page,
    encryptionActions,
    lockEpoch,
  );
  const plainBody =
    encryptionState.status === "plain" ? encryptionState.body : null;
  const pageNotFound = isApiError(error) && error.status === 404;
  const canDraft = Boolean(options?.ensure);
  const [ensured, setEnsured] = useState(false);
  const isDraft = pageNotFound && canDraft && !ensured && !page;
  // Mirrored into refs so doSave reads current values without new deps (same
  // pattern as doSaveRef below). Assigned in an effect rather than during
  // render: React runs every cleanup in a commit before any setup, so the
  // [doSave] cleanup that flushes a pending save on a path change still sees
  // the draft state and ensure callback of the page it was typed on.
  const ensureRef = useRef(options?.ensure);
  const isDraftRef = useRef(false);
  useEffect(() => {
    ensureRef.current = options?.ensure;
    isDraftRef.current = isDraft;
  });
  const updatePage = useUpdatePage();
  // The mutation result object is recreated on every render; mutateAsync is
  // referentially stable and keeps doSave/effect cleanup stable as well.
  const updatePageMutateAsync = updatePage.mutateAsync;

  const editorValueRef = useRef<Descendant[]>([]);
  const bodyOverrideRef = useRef<string | null>(null);

  const [title, setTitleState] = useState("");
  const [tags, setTagsState] = useState<string[]>([]);
  const [aliases, setAliasesState] = useState<string[]>([]);

  // Use refs for metadata so doSave captures latest values without
  // recreating its closure on every keystroke (avoids cascade of
  // callback identity changes through scheduleSave → onChange etc.)
  const titleRef = useRef(title);
  const tagsRef = useRef(tags);
  const aliasesRef = useRef(aliases);
  useEffect(() => {
    titleRef.current = title;
  }, [title]);
  useEffect(() => {
    tagsRef.current = tags;
  }, [tags]);
  useEffect(() => {
    aliasesRef.current = aliases;
  }, [aliases]);

  const savedRef = useRef({
    title: "",
    tags: [] as string[],
    aliases: [] as string[],
    body: "",
  });

  // Generation counters for dirty tracking. Each edit increments the edit gen;
  // successful saves advance the saved gen to the value captured at save start.
  // This way edits during an in-flight save keep the edit gen ahead of saved gen,
  // so onSuccess never accidentally marks them clean.
  const bodyEditGenRef = useRef(0);
  const metaEditGenRef = useRef(0);
  const savedBodyGenRef = useRef(0);
  const savedMetaGenRef = useRef(0);

  const revisionRef = useRef("");
  const savePathRef = useRef(path);
  const saveRequestedRef = useRef(false);
  const saveFlightRef = useRef<{
    epoch: number;
    promise: Promise<void>;
  } | null>(null);
  const conflictRef = useRef<RevisionConflict | null>(null);

  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [revisionConflict, setRevisionConflict] =
    useState<RevisionConflict | null>(null);
  const [editorRevision, setEditorRevision] = useState(0);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doSaveRef = useRef<() => Promise<void>>(async () => undefined);

  const initialValue = useMemo(() => {
    if (!page || plainBody === null)
      return [{ type: "paragraph" as const, children: [{ text: "" }] }];
    return markdownToSlate(plainBody);
  }, [page, plainBody]);

  // A new path is a new page lifecycle: discard the previous page's local
  // baseline before the sync effect below gets a chance to adopt the new
  // page, so it never leaks into the next page while its data loads — most
  // importantly into a 404 draft, whose masked error would otherwise render
  // a live editor over stale values from the page just left. Declared above
  // the sync effect so that within one commit (e.g. a cache-hit path change
  // that delivers the new page synchronously) the order is reset-then-adopt,
  // not adopt-then-reset. previousPathRef distinguishes an actual path
  // change from the initial mount (where resetting would clobber the sync
  // effect's result).
  const previousPathRef = useRef(path);
  // Bumped by the reset below, so each page gets its own lifecycle epoch. A
  // save captures the epoch it started in and drops every baseline write once
  // the epoch no longer matches: without that, a request issued for the page
  // just left resolves into the freshly reset lifecycle and installs a foreign
  // baseline (leaked revision, saved-generation watermarks and metadata),
  // which silently suppresses later saves and re-sends the old page's fields.
  const lifecycleRef = useRef(0);
  useEffect(() => {
    if (previousPathRef.current === path) return;
    previousPathRef.current = path;
    lifecycleRef.current += 1;

    setEnsured(false);
    titleRef.current = "";
    tagsRef.current = [];
    aliasesRef.current = [];
    setTitleState("");
    setTagsState([]);
    setAliasesState([]);
    savedRef.current = { title: "", tags: [], aliases: [], body: "" };
    editorValueRef.current = [];
    bodyOverrideRef.current = null;
    revisionRef.current = "";
    savePathRef.current = path;
    bodyEditGenRef.current = 0;
    metaEditGenRef.current = 0;
    savedBodyGenRef.current = 0;
    savedMetaGenRef.current = 0;
    conflictRef.current = null;
    setRevisionConflict(null);
    setSaveError(null);
    setSaveStatus("saved");
    setEditorRevision((revision) => revision + 1);
  }, [path]);

  const previousLockEpochRef = useRef(lockEpoch);
  useEffect(() => {
    if (!page?.encrypted) {
      previousLockEpochRef.current = lockEpoch;
      return;
    }
    if (previousLockEpochRef.current === lockEpoch) return;
    previousLockEpochRef.current = lockEpoch;
    lifecycleRef.current += 1;
    editorValueRef.current = [];
    bodyOverrideRef.current = null;
    savedRef.current = { ...savedRef.current, body: "" };
    bodyEditGenRef.current = 0;
    savedBodyGenRef.current = 0;
    setEditorRevision((revision) => revision + 1);
  }, [lockEpoch, page?.encrypted]);

  // Sync server data → local state on initial load and genuine external changes.
  // Skip when we have unsaved local edits (dirty), to prevent refetches
  // triggered by our own saves from overwriting in-flight user work.
  useEffect(() => {
    if (!page) return;
    if (conflictRef.current) return;
    const bodyDirty = bodyEditGenRef.current > savedBodyGenRef.current;
    const metaDirty = metaEditGenRef.current > savedMetaGenRef.current;
    if (bodyDirty || metaDirty) return;

    const t = page.meta.title ?? "";
    const tg = page.meta.tags ?? [];
    const al = page.meta.aliases ?? [];
    setTitleState(t);
    setTagsState(tg);
    setAliasesState(al);
    if (plainBody === null) return;
    const shouldResetEditor =
      editorValueRef.current.length === 0 ||
      savedRef.current.body !== plainBody;
    const nextValue = initialValue;
    bodyOverrideRef.current = null;
    savedRef.current = { title: t, tags: tg, aliases: al, body: plainBody };
    revisionRef.current = page.revision;
    editorValueRef.current = nextValue;
    if (shouldResetEditor) {
      setEditorRevision((revision) => revision + 1);
    }
    setSaveStatus("saved");
  }, [initialValue, page, plainBody]);

  const doSave = useCallback((): Promise<void> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (conflictRef.current) {
      setSaveStatus("error");
      return Promise.reject(new Error("Resolve the revision conflict first."));
    }

    const requestedEpoch = lifecycleRef.current;
    const currentFlight = saveFlightRef.current;
    if (currentFlight) {
      if (currentFlight.epoch === requestedEpoch) {
        saveRequestedRef.current = true;
        return currentFlight.promise;
      }
      return currentFlight.promise.then(() => {
        if (lifecycleRef.current !== requestedEpoch) return;
        return doSaveRef.current();
      });
    }

    // Everything below this point may resolve after the editor has moved to
    // another page. `isStale` gates the writes that belong to *this* page's
    // lifecycle; the request itself still completes, since the flush on a path
    // change exists precisely to persist the outgoing page's last edit.
    const saveEpoch = requestedEpoch;
    const isStale = () => lifecycleRef.current !== saveEpoch;
    const encrypted = page?.encrypted === true;

    const savePass = async (): Promise<void> => {
      // Snapshot generation counters at save start. A successful save advances
      // only these watermarks, so edits made while the request is in flight stay
      // dirty and are serialized by the next queued request.
      const saveBodyGen = bodyEditGenRef.current;
      const saveMetaGen = metaEditGenRef.current;
      const bodyDirty = saveBodyGen > savedBodyGenRef.current;
      const bodyOverrideAtSave = bodyOverrideRef.current;
      // Read synchronously: the reset effect clears revisionRef, so the request
      // must not re-read it across an await.
      let expectedRevision = revisionRef.current;
      let requestPath = savePathRef.current;
      const currentTitle = titleRef.current;
      const currentTags = tagsRef.current;
      const currentAliases = aliasesRef.current;
      // Only serialize the Slate tree when the user actually edited body content.
      // This prevents metadata-only edits from losing unsupported markdown nodes.
      const body = bodyDirty
        ? (bodyOverrideAtSave ?? slateToMarkdown(editorValueRef.current))
        : savedRef.current.body;
      const bodyChanged = bodyDirty && body !== savedRef.current.body;
      const titleChanged = currentTitle !== savedRef.current.title;
      const tagsChanged =
        JSON.stringify(currentTags) !== JSON.stringify(savedRef.current.tags);
      const aliasesChanged =
        JSON.stringify(currentAliases) !==
        JSON.stringify(savedRef.current.aliases);

      if (!bodyChanged && !titleChanged && !tagsChanged && !aliasesChanged) {
        savedBodyGenRef.current = saveBodyGen;
        savedMetaGenRef.current = saveMetaGen;
        if (
          bodyEditGenRef.current === saveBodyGen &&
          bodyOverrideRef.current === bodyOverrideAtSave
        ) {
          bodyOverrideRef.current = null;
        }
        setSaveStatus("saved");
        return;
      }

      setSaveStatus("saving");
      try {
        if (isDraftRef.current && ensureRef.current) {
          const result = await ensureRef.current();
          requestPath = result.page.path;
          expectedRevision = result.page.revision;
          const serverTitle = result.page.meta.title ?? "";
          const serverTags = result.page.meta.tags ?? [];
          const serverAliases = result.page.meta.aliases ?? [];

          if (!result.created && result.page.body.trim() !== "") {
            // The page was created and written elsewhere between load and
            // save. Surface the conflict-reload flow instead of overwriting.
            saveRequestedRef.current = false;
            if (isStale()) return;
            const conflict = { currentRevision: result.page.revision };
            conflictRef.current = conflict;
            setRevisionConflict(conflict);
            setSaveStatus("error");
            setSaveError("page already has content");
            throw new Error("page already has content");
          }

          // Adopt the created page as the local baseline — unless the editor
          // has moved on, where the drafted body is still written to the page
          // it was typed on (via expectedRevision) but the now-current page's
          // lifecycle must stay untouched.
          if (!isStale()) {
            savePathRef.current = requestPath;
            revisionRef.current = result.page.revision;
            savedRef.current = {
              title: serverTitle,
              tags: serverTags,
              aliases: serverAliases,
              body: result.page.body,
            };
            // Adopt template metadata the user did not touch while drafting;
            // fields they edited diff against the new baseline instead.
            if (titleRef.current === "") {
              titleRef.current = serverTitle;
              setTitleState(serverTitle);
            }
            if (tagsRef.current.length === 0) {
              tagsRef.current = serverTags;
              setTagsState(serverTags);
            }
            if (aliasesRef.current.length === 0) {
              aliasesRef.current = serverAliases;
              setAliasesState(serverAliases);
            }
            isDraftRef.current = false;
            setEnsured(true);
          }
        }

        let requestBody: string | undefined;
        if (bodyChanged) {
          if (encrypted) {
            const identity = encryptionActions?.getIdentity();
            if (!identity) throw new Error("Vault is locked.");
            const recipient = await recipientForIdentity(identity);
            requestBody = await encryptMarkdown(body, recipient);
          } else {
            requestBody = body;
          }
        }

        const response = await updatePageMutateAsync({
          params: { path: { path: requestPath } },
          body: {
            expected_revision: expectedRevision,
            ...(titleChanged ? { title: currentTitle || null } : {}),
            ...(tagsChanged ? { tags: currentTags } : {}),
            ...(aliasesChanged ? { aliases: currentAliases } : {}),
            ...(requestBody !== undefined ? { body: requestBody } : {}),
          },
        });

        // A queued save belonged to the page just left; it is not drained into
        // the current one, whose own edits schedule their own save.
        if (isStale()) return;

        revisionRef.current = response.revision;
        savedRef.current = {
          title: response.meta.title ?? "",
          tags: response.meta.tags ?? [],
          aliases: response.meta.aliases ?? [],
          body: encrypted
            ? bodyChanged
              ? body
              : savedRef.current.body
            : response.body,
        };
        savedBodyGenRef.current = saveBodyGen;
        savedMetaGenRef.current = saveMetaGen;
        if (
          bodyEditGenRef.current === saveBodyGen &&
          bodyOverrideRef.current === bodyOverrideAtSave
        ) {
          bodyOverrideRef.current = null;
        }
        setSaveError(null);

        const stillDirty =
          bodyEditGenRef.current > savedBodyGenRef.current ||
          metaEditGenRef.current > savedMetaGenRef.current;
        setSaveStatus(stillDirty ? "unsaved" : "saved");
      } catch (err) {
        saveRequestedRef.current = false;
        if (isStale()) return;
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        const conflict = decodeRevisionConflict(err);
        if (conflict) {
          conflictRef.current = conflict;
          setRevisionConflict(conflict);
        }
        setSaveStatus("error");
        setSaveError(
          isApiError(err)
            ? err.error
            : err instanceof Error
              ? err.message
              : "Save failed",
        );
        throw err;
      }
    };

    let flightPromise!: Promise<void>;
    flightPromise = (async () => {
      do {
        saveRequestedRef.current = false;
        await savePass();
      } while (saveRequestedRef.current && !isStale());
    })().finally(() => {
      if (saveFlightRef.current?.promise === flightPromise) {
        saveFlightRef.current = null;
      }
    });
    saveFlightRef.current = { epoch: saveEpoch, promise: flightPromise };
    return flightPromise;
  }, [encryptionActions, page?.encrypted, path, updatePageMutateAsync]);

  doSaveRef.current = doSave;

  const reloadAfterConflict = useCallback(async () => {
    if (!conflictRef.current) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const reloadEpoch = lifecycleRef.current;

    try {
      const result = await refetchPage();
      if (lifecycleRef.current !== reloadEpoch) return;
      const latest = result.data;
      if (!latest) {
        setSaveStatus("error");
        setSaveError("Failed to reload page");
        return;
      }

      const nextTitle = latest.meta.title ?? "";
      const nextTags = latest.meta.tags ?? [];
      const nextAliases = latest.meta.aliases ?? [];
      let latestBody = latest.body;
      if (latest.encrypted) {
        const identity = encryptionActions?.getIdentity();
        if (!identity) throw new Error("Vault is locked.");
        try {
          latestBody = await decryptMarkdown(latest.body, identity);
          if (lifecycleRef.current !== reloadEpoch) return;
        } catch {
          throw new Error("Unable to authenticate encrypted note.");
        }
      }
      if (lifecycleRef.current !== reloadEpoch) return;
      const nextValue = markdownToSlate(latestBody);
      bodyOverrideRef.current = null;
      titleRef.current = nextTitle;
      tagsRef.current = nextTags;
      aliasesRef.current = nextAliases;
      setTitleState(nextTitle);
      setTagsState(nextTags);
      setAliasesState(nextAliases);
      editorValueRef.current = nextValue;
      savedRef.current = {
        title: nextTitle,
        tags: nextTags,
        aliases: nextAliases,
        body: latestBody,
      };
      savedBodyGenRef.current = bodyEditGenRef.current;
      savedMetaGenRef.current = metaEditGenRef.current;
      revisionRef.current = latest.revision;
      saveRequestedRef.current = false;
      conflictRef.current = null;
      setRevisionConflict(null);
      setSaveError(null);
      setSaveStatus("saved");
      setEditorRevision((revision) => revision + 1);
    } catch (err) {
      if (lifecycleRef.current !== reloadEpoch) return;
      setSaveStatus("error");
      setSaveError(
        isApiError(err)
          ? err.error
          : err instanceof Error
            ? err.message
            : "Save failed",
      );
    }
  }, [encryptionActions, refetchPage]);

  const scheduleSave = useCallback(() => {
    clearTimeout(timerRef.current ?? undefined);
    if (conflictRef.current) {
      setSaveStatus("error");
      return;
    }
    setSaveStatus("unsaved");
    timerRef.current = setTimeout(() => {
      void doSave().catch(() => undefined);
    }, DEBOUNCE_MS);
  }, [doSave]);

  const onSlateChange = useCallback(
    (value: Descendant[], editor: Editor) => {
      editorValueRef.current = value;
      // Only schedule a save if there are actual content changes,
      // not just selection/cursor movements
      const isAstChange = editor.operations.some(
        (op) => op.type !== "set_selection",
      );
      if (isAstChange) {
        bodyOverrideRef.current = null;
        bodyEditGenRef.current += 1;
        scheduleSave();
      }
    },
    [scheduleSave],
  );

  // Setters keep the corresponding ref in sync *synchronously* (in addition
  // to the effects above, which cover server-load syncs). This lets a blur
  // flush call saveNow() in the same tick and still serialize the just-set
  // value instead of the stale one.
  const setTitle = useCallback(
    (t: string) => {
      titleRef.current = t;
      setTitleState(t);
      metaEditGenRef.current += 1;
      scheduleSave();
    },
    [scheduleSave],
  );

  const setTags = useCallback(
    (t: string[]) => {
      tagsRef.current = t;
      setTagsState(t);
      metaEditGenRef.current += 1;
      scheduleSave();
    },
    [scheduleSave],
  );

  const setAliases = useCallback(
    (a: string[]) => {
      aliasesRef.current = a;
      setAliasesState(a);
      metaEditGenRef.current += 1;
      scheduleSave();
    },
    [scheduleSave],
  );

  const setBodyMarkdown = useCallback(
    (markdown: string) => {
      const nextValue = markdownToSlate(markdown);
      bodyOverrideRef.current = markdown;
      editorValueRef.current = nextValue;
      bodyEditGenRef.current += 1;
      scheduleSave();
    },
    [scheduleSave],
  );

  const encrypted = page?.encrypted === true;
  useEffect(() => {
    if (!encrypted || !encryptionActions) return;
    return encryptionActions.registerFlusher(doSave);
  }, [doSave, encrypted, encryptionActions]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden" && timerRef.current) {
        void doSave().catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      // Flush rather than drop: a cleared timer would silently lose the last
      // unsaved edit when the editor unmounts (navigation, page switch).
      if (timerRef.current) void doSave().catch(() => undefined);
    };
  }, [doSave]);

  const getPlaintext = useCallback(() => {
    const bodyDirty = bodyEditGenRef.current > savedBodyGenRef.current;
    return bodyDirty
      ? (bodyOverrideRef.current ?? slateToMarkdown(editorValueRef.current))
      : savedRef.current.body;
  }, []);

  const getRevision = useCallback(() => revisionRef.current, []);

  const localEditorIsDirty =
    bodyEditGenRef.current > savedBodyGenRef.current ||
    metaEditGenRef.current > savedMetaGenRef.current;
  const editorRemountPending =
    previousPathRef.current !== path ||
    (page?.encrypted === true && previousLockEpochRef.current !== lockEpoch) ||
    (page !== undefined &&
      plainBody !== null &&
      !conflictRef.current &&
      !localEditorIsDirty &&
      (editorValueRef.current.length === 0 ||
        savedRef.current.body !== plainBody));
  const isEditorSynchronized =
    !isLoading &&
    (error != null ||
      (isDraft && !editorRemountPending) ||
      (page !== undefined && plainBody !== null && !editorRemountPending));

  // Sent on its own: a metadata-only write is permitted even while the body is
  // still protected, which is what lets a reader unlock an archived page.
  const setReadonly = useCallback(
    async (readonly: boolean) => {
      const expectedRevision = getRevision();
      if (!expectedRevision) return;
      await updatePageMutateAsync({
        params: { path: { path } },
        body: { expected_revision: expectedRevision, readonly },
      });
    },
    [getRevision, path, updatePageMutateAsync],
  );

  return {
    isLoading,
    error: pageNotFound && canDraft ? null : error,
    pageNotFound,
    isDraft,
    initialValue,
    editorValue:
      previousPathRef.current === path && editorValueRef.current.length > 0
        ? editorValueRef.current
        : initialValue,
    editorRevision,
    isEditorSynchronized,
    title,
    setTitle,
    tags,
    computedTags: page?.computed_tags ?? [],
    setTags,
    aliases,
    setAliases,
    saveStatus,
    saveError,
    revisionConflict,
    reloadAfterConflict,
    onSlateChange,
    setBodyMarkdown,
    saveNow: doSave,
    createdAt: page?.meta?.created_at ?? null,
    updatedAt: page?.meta?.updated_at ?? null,
    archive: page?.meta.archive ?? null,
    bodyMarkdown: plainBody ?? "",
    kind: page?.kind ?? null,
    conversationProvider: page?.conversation?.provider ?? null,
    inferred: page?.inferred ?? true,
    readonly: page?.readonly ?? false,
    setReadonly,
    project: page?.project ?? null,
    encryptionState,
    pageId: page?.meta.id ?? null,
    encrypted: page?.encrypted ?? false,
    getPlaintext,
    getRevision,
  };
}
