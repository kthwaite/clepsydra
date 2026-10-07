import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFolioMode } from "#/components/codex/useFolioMode";
import type { RecipeParseResult } from "#/recipe/recipeCodec";

const BROKEN: RecipeParseResult = { ok: false, reason: "missing-section" };

describe("useFolioMode", () => {
  it("starts every mode in read", () => {
    const { result } = renderHook(() => useFolioMode("notes/a.md"));
    expect(result.current.conversationMode).toBe("read");
    expect(result.current.recipeMode).toBe("read");
    expect(result.current.projectedRecipe(0)).toBeNull();
  });

  it("keeps modes and the projection while the path stays", () => {
    const { result, rerender } = renderHook(({ path }) => useFolioMode(path), {
      initialProps: { path: "recipes/a.md" },
    });
    act(() => {
      result.current.setConversationMode("edit");
      result.current.setRecipeMode("edit");
      result.current.projectRecipe(3, BROKEN);
    });
    rerender({ path: "recipes/a.md" });
    expect(result.current.conversationMode).toBe("edit");
    expect(result.current.recipeMode).toBe("edit");
    expect(result.current.projectedRecipe(3)).toBe(BROKEN);
  });

  it("only hands back a projection for its editor revision", () => {
    const { result } = renderHook(() => useFolioMode("recipes/a.md"));
    act(() => result.current.projectRecipe(3, BROKEN));
    expect(result.current.projectedRecipe(4)).toBeNull();
  });

  it("resets modes and the projection when the path changes", () => {
    const { result, rerender } = renderHook(({ path }) => useFolioMode(path), {
      initialProps: { path: "recipes/a.md" },
    });
    act(() => {
      result.current.setConversationMode("edit");
      result.current.setRecipeMode("edit");
      result.current.projectRecipe(3, BROKEN);
    });
    rerender({ path: "recipes/b.md" });
    expect(result.current.conversationMode).toBe("read");
    expect(result.current.recipeMode).toBe("read");
    expect(result.current.projectedRecipe(3)).toBeNull();
  });
});
