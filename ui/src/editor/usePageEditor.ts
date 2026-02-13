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

  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const initialValue = useMemo(() => {
    if (!page)
      return [{ type: "paragraph" as const, children: [{ text: "" }] }];
    return markdownToSlate(page.body);
  }, [page]);

  useEffect(() => {
    if (!page) return;
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

    const body = slateToMarkdown(editorValueRef.current);
    const currentTitle = titleRef.current;
    const currentTags = tagsRef.current;
    const currentAliases = aliasesRef.current;

    const bodyChanged = body !== savedRef.current.body;
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
        scheduleSave();
      }
    },
    [scheduleSave],
  );

  const setTitle = useCallback(
    (t: string) => {
      setTitleState(t);
      scheduleSave();
    },
    [scheduleSave],
  );

  const setTags = useCallback(
    (t: string[]) => {
      setTagsState(t);
      scheduleSave();
    },
    [scheduleSave],
  );

  const setAliases = useCallback(
    (a: string[]) => {
      setAliasesState(a);
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
