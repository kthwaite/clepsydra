import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("#/api/pages", () => ({ usePage: () => ({ data: undefined }) }));
vi.mock("#/api/index", () => ({ useBacklinks: () => ({ data: undefined }) }));
vi.mock("#/api/bases", () => ({
  usePageBaseProperties: () => ({
    data: undefined,
    isPending: false,
    isError: false,
  }),
}));
vi.mock("#/components/codex/PreviewBody", () => ({
  PreviewBody: () => <div data-testid="preview-body" />,
}));

import { TabPreviewCard } from "#/components/codex/TabPreviewCard";

describe("TabPreviewCard", () => {
  it("is a raised, rounded card with a soft shadow and no border", () => {
    render(
      <TabPreviewCard path="notes/a.md" rect={new DOMRect(10, 10, 100, 20)} />,
    );
    const card = document.body.querySelector(
      "[data-testid=preview-body]",
    )?.parentElement;
    expect(card).toHaveClass("bg-raise", "rounded-xl", "shadow-lg");
    expect(card?.className).not.toMatch(/border/);
  });
});
