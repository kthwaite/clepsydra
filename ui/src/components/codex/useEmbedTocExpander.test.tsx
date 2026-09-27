import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type * as ApiClientModule from "#/api/client";
import { buildToc } from "#/components/codex/folioToc";
import { useEmbedTocExpander } from "#/components/codex/useEmbedTocExpander";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("#/api/client", async (original) => {
  const actual = await original<typeof ApiClientModule>();
  return { ...actual, fetchClient: { ...actual.fetchClient, POST: post } };
});

const PAGE = "beers.md";
const embed = {
  type: "base-embed",
  status: "configured",
  base: "beer-tasting-notes",
  template: "beer-notes",
  children: [{ text: "" }],
};
const region = {
  type: "generated-region",
  status: "valid",
  rawBlock: "",
  descriptor: {},
  payload: "\n# Snapshot\n\nText.\n",
  children: [{ text: "" }],
};
const value = [
  { type: "heading", level: 1, children: [{ text: "Base" }] },
  embed,
  region,
];

function wrapperWith(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useEmbedTocExpander", () => {
  it("adds a live embed's cached headings and a snapshot's headings to the outline", () => {
    const client = new QueryClient();
    client.setQueryData(
      [
        "post",
        "/api/vault/base-render/render",
        {
          selection: { base: "beer-tasting-notes", template: "beer-notes" },
          page_path: PAGE,
        },
      ],
      {
        markdown: "# Lagers\n\n## Newbarns, 'Pilsner Beer'\n\nPerfect.\n",
        selected_count: 1,
      },
    );
    const { result } = renderHook(() => useEmbedTocExpander(value, PAGE), {
      wrapper: wrapperWith(client),
    });

    expect(buildToc(value, result.current).map((e) => e.text)).toEqual([
      "Base",
      "Lagers",
      "Newbarns, 'Pilsner Beer'",
      "Snapshot",
    ]);
  });

  it("leaves a live embed out until its render is cached, without fetching", () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useEmbedTocExpander(value, PAGE), {
      wrapper: wrapperWith(client),
    });

    expect(buildToc(value, result.current).map((e) => e.text)).toEqual([
      "Base",
      "Snapshot",
    ]);
    expect(post).not.toHaveBeenCalled();
  });
});
