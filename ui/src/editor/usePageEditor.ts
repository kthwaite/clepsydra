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
  // The mutation result object is recreated on every render; only .mutate is
  // referentially stable. doSave must depend on the stable function, or the
  // [doSave]-keyed effect below re-runs each render and its cleanup would
  // flush the pending debounce timer prematurely.
  const updatePageMutate = updatePage.mutate;

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

  // Monotonic counter incremented on every doSave attempt (including no-op
  // reconciliations that don't send a mutation). onSuccess/onError callbacks
  // capture the value at fire time and no-op if a newer save attempt has been
  // initiated, preventing stale responses from regressing savedRef or status.
  const saveSeqRef = useRef(0);

  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editorRevision, setEditorRevision] = useState(0);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    // Invalidate callbacks from older in-flight saves on every save attempt,
    // including no-op reconciliation paths that don't send a mutation.
    saveSeqRef.current += 1;
    const thisSaveSeq = saveSeqRef.current;

    // Snapshot generation counters at save start. onSuccess advances the
    // saved watermark to these values — edits that arrive during the save
    // flight will have incremented past them and stay dirty.
    const saveBodyGen = bodyEditGenRef.current;
    const saveMetaGen = metaEditGenRef.current;
    const bodyDirty = saveBodyGen > savedBodyGenRef.current;

    const currentTitle = titleRef.current;
    const currentTags = tagsRef.current;
    const currentAliases = aliasesRef.current;

    // Only serialize the Slate tree when the user actually edited body content.
    // This prevents the lossy mdast→slate→mdast round-trip from silently
    // dropping unsupported markdown nodes (tables, HTML blocks, footnotes, etc.)
    // when only metadata was changed.
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
      // User reverted to saved state — clear the dirty gap so the sync
      // effect can accept future refetches again.
      savedBodyGenRef.current = saveBodyGen;
      savedMetaGenRef.current = saveMetaGen;
      setSaveStatus("saved");
      return;
    }

    setSaveStatus("saving");

    updatePageMutate(
      {
        params: { path: { path } },
        body: {
          ...(titleChanged ? { title: currentTitle || null } : {}),
          ...(tagsChanged ? { tags: currentTags } : {}),
          ...(aliasesChanged ? { aliases: currentAliases } : {}),
          ...(bodyChanged ? { body } : {}),
        },
      },
      {
        onSuccess: () => {
          // Stale response guard: if a newer save was initiated, this
          // response is outdated — skip to avoid regressing savedRef.
          if (thisSaveSeq !== saveSeqRef.current) return;

          savedRef.current = {
            title: currentTitle,
            tags: currentTags,
            aliases: currentAliases,
            body,
          };
          // Advance saved watermarks to the generation captured at save start.
          // If user edited during flight, edit gens will be higher and dirty
          // state is preserved; if not, gens match and dirty clears.
          savedBodyGenRef.current = saveBodyGen;
          savedMetaGenRef.current = saveMetaGen;
          setSaveStatus("saved");
          setSaveError(null);
        },
        onError: (err) => {
          if (thisSaveSeq !== saveSeqRef.current) return;
          setSaveStatus("error");
          setSaveError(err instanceof Error ? err.message : "Save failed");
        },
      },
    );
  }, [path, updatePageMutate]);

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
      // Flush rather than drop: a cleared timer would silently lose the last
      // unsaved edit when the editor unmounts (navigation, page switch).
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
