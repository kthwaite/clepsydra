import { useMemo } from "react";
import { type RenderSelection, useCachedLiveBaseRenders } from "#/api/bases";
import { baseRenderSelection } from "#/components/bases/embed-query";
import type { TocExpander } from "#/components/codex/folioToc";
import { markdownToSlate } from "#/editor/convert";
import type { BaseEmbedElement, GeneratedRegionElement } from "#/editor/types";

type RenderedBlock =
  | { node: unknown; kind: "live"; selection: RenderSelection }
  | { node: unknown; kind: "snapshot"; markdown: string };

function renderedBlocks(value: unknown): RenderedBlock[] {
  if (!Array.isArray(value)) return [];
  const blocks: RenderedBlock[] = [];
  for (const node of value) {
    const element = node as BaseEmbedElement | GeneratedRegionElement;
    if (
      element?.type === "base-embed" &&
      element.status === "configured" &&
      element.template
    ) {
      blocks.push({
        node,
        kind: "live",
        selection: baseRenderSelection(element),
      });
    } else if (
      element?.type === "generated-region" &&
      element.status === "valid"
    ) {
      blocks.push({ node, kind: "snapshot", markdown: element.payload });
    }
  }
  return blocks;
}

/**
 * Lets the Folio outline include the headings a template-rendered Base embed
 * or a generated region shows. Live embeds contribute once their render is in
 * the cache; this hook never starts a render of its own.
 */
export function useEmbedTocExpander(
  value: unknown,
  pagePath: string,
): TocExpander | undefined {
  const blocks = useMemo(() => renderedBlocks(value), [value]);
  const live = blocks.filter((block) => block.kind === "live");
  const renders = useCachedLiveBaseRenders(
    live.map((block) => block.selection),
    pagePath,
  );
  const liveMarkdown = renders.map((render) => render.data?.markdown);
  const liveKey = liveMarkdown.join("\u0000");

  // biome-ignore lint/correctness/useExhaustiveDependencies: liveKey stands in for the per-render markdown array, which is new every render.
  return useMemo(() => {
    if (blocks.length === 0) return undefined;
    const expansions = new Map<unknown, readonly unknown[]>();
    let liveIndex = 0;
    for (const block of blocks) {
      const markdown =
        block.kind === "snapshot" ? block.markdown : liveMarkdown[liveIndex++];
      if (markdown !== undefined) {
        expansions.set(block.node, markdownToSlate(markdown));
      }
    }
    return (node) => expansions.get(node) ?? null;
  }, [blocks, liveKey]);
}
