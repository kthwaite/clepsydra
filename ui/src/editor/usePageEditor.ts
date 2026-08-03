import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Descendant, Editor } from "slate";
import { usePage, useUpdatePage } from "#/api/pages";
import { markdownToSlate, slateToMarkdown } from "./convert";

export type SaveStatus = "saved" | "saving" | "unsaved" | "error";

const DEBOUNCE_MS = 1500;

interface PageEditorState {
  isLoading: boolean;
  error: unknown;
  initialValue: Descendant[];
  editorRevision: number;
  title: string;
  setTitle: (t: string) => void;
  tags: string[];
  setTags: (t: string[]) => void;
  aliases: string[];
  setAliases: (a: string[]) => void;
  saveStatus: SaveStatus;
  saveError: string | null;
  onSlateChange: (value: Descendant[], editor: Editor) => void;
  saveNow: () => void;
  createdAt: string | null;
  updatedAt: string | null;
  bodyMarkdown: string;
  kind: string | null;
  inferred: boolean;
  project: string | null;
}

export function usePageEditor(path: string): PageEditorState {
  const { data: page, isLoading, error } = usePage(path);
  const updatePage = useUpdatePage();
  // The mutation result object is recreated on every render; mutateAsync is
  // referentially stable and keeps doSave/effect cleanup stable as well.
  const updatePageMutateAsync = updatePage.mutateAsync;

  const editorValueRef = useRef<Descendant[]>([]);

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
  const savingRef = useRef(false);
  const saveRequestedRef = useRef(false);

  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editorRevision, setEditorRevision] = useState(0);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doSaveRef = useRef<() => void>(() => undefined);

  const initialValue = useMemo(() => {
    if (!page)
      return [{ type: "paragraph" as const, children: [{ text: "" }] }];
    return markdownToSlate(page.body);
  }, [page]);

  // Sync server data → local state on initial load and genuine external changes.
  // Skip when we have unsaved local edits (dirty), to prevent refetches
  // triggered by our own saves from overwriting in-flight user work.
  useEffect(() => {
    if (!page) return;
    const bodyDirty = bodyEditGenRef.current > savedBodyGenRef.current;
    const metaDirty = metaEditGenRef.current > savedMetaGenRef.current;
    if (bodyDirty || metaDirty) return;

    const t = page.meta.title ?? "";
    const tg = page.meta.tags ?? [];
    const al = page.meta.aliases ?? [];
    setTitleState(t);
    setTagsState(tg);
    setAliasesState(al);
    const shouldResetEditor =
      editorValueRef.current.length === 0 ||
      savedRef.current.body !== page.body;
    const nextValue = markdownToSlate(page.body);
    savedRef.current = { title: t, tags: tg, aliases: al, body: page.body };
    revisionRef.current = page.revision;
    editorValueRef.current = nextValue;
    if (shouldResetEditor) {
      setEditorRevision((revision) => revision + 1);
    }
    setSaveStatus("saved");
  }, [page]);

  const doSave = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (savingRef.current) {
      saveRequestedRef.current = true;
      return;
    }

    // Snapshot generation counters at save start. A successful save advances
    // only these watermarks, so edits made while the request is in flight stay
    // dirty and are serialized by the next queued request.
    const saveBodyGen = bodyEditGenRef.current;
    const saveMetaGen = metaEditGenRef.current;
    const bodyDirty = saveBodyGen > savedBodyGenRef.current;

    const currentTitle = titleRef.current;
    const currentTags = tagsRef.current;
    const currentAliases = aliasesRef.current;

    // Only serialize the Slate tree when the user actually edited body content.
    // This prevents metadata-only edits from losing unsupported markdown nodes.
    const body = bodyDirty
      ? slateToMarkdown(editorValueRef.current)
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
      setSaveStatus("saved");
      return;
    }

    savingRef.current = true;
    setSaveStatus("saving");

    void (async () => {
      try {
        const response = await updatePageMutateAsync({
          params: { path: { path } },
          body: {
            expected_revision: revisionRef.current,
            ...(titleChanged ? { title: currentTitle || null } : {}),
            ...(tagsChanged ? { tags: currentTags } : {}),
            ...(aliasesChanged ? { aliases: currentAliases } : {}),
            ...(bodyChanged ? { body } : {}),
          },
        });

        revisionRef.current = response.revision;
        savedRef.current = {
          title: response.meta.title ?? "",
          tags: response.meta.tags ?? [],
          aliases: response.meta.aliases ?? [],
          body: response.body,
        };
        savedBodyGenRef.current = saveBodyGen;
        savedMetaGenRef.current = saveMetaGen;
        savingRef.current = false;
        setSaveError(null);

        const shouldDrain = saveRequestedRef.current;
        saveRequestedRef.current = false;
        if (shouldDrain) {
          doSaveRef.current();
          return;
        }

        const stillDirty =
          bodyEditGenRef.current > savedBodyGenRef.current ||
          metaEditGenRef.current > savedMetaGenRef.current;
        setSaveStatus(stillDirty ? "unsaved" : "saved");
      } catch (err) {
        savingRef.current = false;
        saveRequestedRef.current = false;
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        setSaveStatus("error");
        setSaveError(err instanceof Error ? err.message : "Save failed");
      }
    })();
  }, [path, updatePageMutateAsync]);

  doSaveRef.current = doSave;

  const scheduleSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setSaveStatus("unsaved");
    timerRef.current = setTimeout(doSave, DEBOUNCE_MS);
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

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden" && timerRef.current) {
        doSave();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (timerRef.current) doSave();
    };
  }, [doSave]);

  return {
    isLoading,
    error,
    initialValue,
    editorRevision,
    title,
    setTitle,
    tags,
    setTags,
    aliases,
    setAliases,
    saveStatus,
    saveError,
    onSlateChange,
    saveNow: doSave,
    createdAt: page?.meta?.created_at ?? null,
    updatedAt: page?.meta?.updated_at ?? null,
    bodyMarkdown: page?.body ?? "",
    kind: page?.kind ?? null,
    inferred: page?.inferred ?? true,
    project: page?.project ?? null,
  };
}
