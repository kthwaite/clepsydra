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
}

export function usePageEditor(path: string): PageEditorState {
  const { data: page, isLoading, error } = usePage(path);
  const updatePage = useUpdatePage();

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

  // Tracks whether the user has made actual body edits (AST changes).
  // Used to:
  // 1. Skip overwriting editor state on refetches triggered by our own saves
  // 2. Avoid serializing the lossy Slate tree when only metadata changed,
  //    which would silently drop unsupported markdown nodes (tables, HTML, etc.)
  const bodyDirtyRef = useRef(false);
  // Tracks whether metadata (title/tags/aliases) has local unsaved changes
  const metaDirtyRef = useRef(false);

  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);

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
    if (bodyDirtyRef.current || metaDirtyRef.current) return;

    const t = page.meta.title ?? "";
    const tg = page.meta.tags ?? [];
    const al = page.meta.aliases ?? [];
    setTitleState(t);
    setTagsState(tg);
    setAliasesState(al);
    savedRef.current = { title: t, tags: tg, aliases: al, body: page.body };
    editorValueRef.current = initialValue;
    setSaveStatus("saved");
  }, [page, initialValue]);

  const doSave = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const currentTitle = titleRef.current;
    const currentTags = tagsRef.current;
    const currentAliases = aliasesRef.current;

    // Only serialize the Slate tree when the user actually edited body content.
    // This prevents the lossy mdast→slate→mdast round-trip from silently
    // dropping unsupported markdown nodes (tables, HTML blocks, footnotes, etc.)
    // when only metadata was changed.
    const body = bodyDirtyRef.current
      ? slateToMarkdown(editorValueRef.current)
      : savedRef.current.body;
    const bodyChanged = bodyDirtyRef.current && body !== savedRef.current.body;

    const titleChanged = currentTitle !== savedRef.current.title;
    const tagsChanged =
      JSON.stringify(currentTags) !== JSON.stringify(savedRef.current.tags);
    const aliasesChanged =
      JSON.stringify(currentAliases) !==
      JSON.stringify(savedRef.current.aliases);

    if (!bodyChanged && !titleChanged && !tagsChanged && !aliasesChanged) {
      setSaveStatus("saved");
      return;
    }

    setSaveStatus("saving");

    updatePage.mutate(
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
          savedRef.current = {
            title: currentTitle,
            tags: currentTags,
            aliases: currentAliases,
            body,
          };
          bodyDirtyRef.current = false;
          metaDirtyRef.current = false;
          setSaveStatus("saved");
          setSaveError(null);
        },
        onError: (err) => {
          setSaveStatus("error");
          setSaveError(err instanceof Error ? err.message : "Save failed");
        },
      },
    );
  }, [path, updatePage]);

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
        bodyDirtyRef.current = true;
        scheduleSave();
      }
    },
    [scheduleSave],
  );

  const setTitle = useCallback(
    (t: string) => {
      setTitleState(t);
      metaDirtyRef.current = true;
      scheduleSave();
    },
    [scheduleSave],
  );

  const setTags = useCallback(
    (t: string[]) => {
      setTagsState(t);
      metaDirtyRef.current = true;
      scheduleSave();
    },
    [scheduleSave],
  );

  const setAliases = useCallback(
    (a: string[]) => {
      setAliasesState(a);
      metaDirtyRef.current = true;
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
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [doSave]);

  return {
    isLoading,
    error,
    initialValue,
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
  };
}
