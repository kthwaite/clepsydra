import { useCallback, useEffect, useRef, useState } from "react";
import type { FolioMode } from "#/components/codex/folioSurface";
import type { RecipeParseResult } from "#/recipe/recipeCodec";

type RecipeProjection = {
  path: string;
  editorRevision: number;
  result: RecipeParseResult;
};

/** The Folio's read/edit modes and the recipe projection, reset per page. */
export function useFolioMode(path: string) {
  const [conversationMode, setConversationMode] = useState<FolioMode>("read");
  const [recipeMode, setRecipeMode] = useState<FolioMode>("read");
  const [recipeProjection, setRecipeProjection] =
    useState<RecipeProjection | null>(null);
  const modePathRef = useRef(path);
  useEffect(() => {
    if (modePathRef.current === path) return;
    modePathRef.current = path;
    setConversationMode("read");
    setRecipeMode("read");
    setRecipeProjection(null);
  }, [path]);

  // A recipe edit or raw apply knows its parse before the editor re-derives
  // one; the projection carries it until the editor revision moves on.
  const projectRecipe = useCallback(
    (editorRevision: number, result: RecipeParseResult) => {
      setRecipeProjection({ path, editorRevision, result });
    },
    [path],
  );
  const projectedRecipe = (editorRevision: number) =>
    recipeProjection?.path === path &&
    recipeProjection.editorRevision === editorRevision
      ? recipeProjection.result
      : null;

  return {
    conversationMode,
    setConversationMode,
    recipeMode,
    setRecipeMode,
    projectRecipe,
    projectedRecipe,
  };
}
