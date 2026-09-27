import wikiLinkPlugin from "remark-wiki-link";
import type { PluggableList } from "unified";

/**
 * hast property that carries a wikilink's raw target (`Target#Heading` from
 * `[[Target#Heading|Alias]]`) to the renderer's `a` component. React renders
 * it as `data-wikilink-target`.
 */
const WIKILINK_TARGET_PROPERTY = "dataWikilinkTarget";

interface MutableNode {
  type: string;
  value?: unknown;
  data?: { hProperties?: Record<string, unknown> };
  children?: MutableNode[];
}

function markWikilinkTargets(node: MutableNode): void {
  if (node.type === "wikiLink" && typeof node.value === "string") {
    // Replace the plugin's slug href and class names: a wikilink resolves
    // through the vault index, never by rewriting its name into a path.
    node.data = {
      ...node.data,
      hProperties: { [WIKILINK_TARGET_PROPERTY]: node.value },
    };
    return;
  }
  for (const child of node.children ?? []) markWikilinkTargets(child);
}

function remarkWikilinkTargets() {
  return (tree: MutableNode) => markWikilinkTargets(tree);
}

/**
 * remark-wiki-link, configured for read-only renderers. The raw target is kept
 * verbatim (no lowercasing or `_` for spaces), and each wikilink becomes an
 * `a` with no href and a `data-wikilink-target` property instead.
 */
export const remarkWikilinks: PluggableList = [
  [
    wikiLinkPlugin,
    { aliasDivider: "|", pageResolver: (name: string) => [name] },
  ],
  remarkWikilinkTargets,
];

/** The raw wikilink target of a rendered `a` hast node, or null for other links. */
export function wikilinkTarget(
  node: { properties?: Record<string, unknown> } | undefined,
): string | null {
  const target = node?.properties?.[WIKILINK_TARGET_PROPERTY];
  return typeof target === "string" ? target : null;
}

/** The in-app href for a vault page path. */
export function pageHref(path: string): string {
  return `/pages/${encodeURIComponent(path)}`;
}
