import type {
  BlockContent,
  InlineCode,
  ListItem,
  Nodes,
  PhrasingContent,
  Root,
  RootContent,
} from "mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import type { Options } from "mdast-util-to-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import type { Descendant } from "slate";
import { Text as SlateText } from "slate";
import type { SerializeCtx } from "#/editor/schema/descriptor";
import { getDescriptor } from "#/editor/schema/registry";
import type { CustomElement, CustomText } from "#/editor/types";
import { folioMathToMarkdown } from "#/lib/markdown/folioMath";
import { baseFenceToMarkdown } from "./baseEmbedMarkdown";
import type {
  BaseFenceMdast,
  FolioInlineMathMdast,
  FolioMathMdast,
  WikiLinkMdast,
} from "./mdastTypes";

// ---------------------------------------------------------------------------
// toMarkdown extension for wikilinks
// ---------------------------------------------------------------------------

function wikiLinkToMarkdownExtension(): Options {
  return {
    handlers: {
      wikiLink(node: WikiLinkMdast) {
        const { permalink, alias } = node.data;
        if (alias && alias !== permalink) {
          return `[[${permalink}|${alias}]]`;
        }
        return `[[${permalink}]]`;
      },
    } as Options["handlers"],
    unsafe: [
      { character: "[", inConstruct: "phrasing" as never },
      { character: "]", inConstruct: "phrasing" as never },
    ],
  };
}

// ---------------------------------------------------------------------------
// toMarkdown extension for single-tilde strikethrough
// ---------------------------------------------------------------------------

function singleTildeStrikethroughExtension(): Options {
  return {
    handlers: {
      delete(node: any, _parent: any, state: any, info: any) {
        const exit = state.enter("strikethrough");
        const value = state.containerPhrasing(node, {
          ...info,
          before: "~",
          after: "~",
        });
        exit();
        return `~${value}~`;
      },
    },
  };
}

/**
 * mdast-util-gfm's task-list handler delegates to the default list-item
 * handler before adding the checkbox marker. For an empty paragraph, the
 * default handler ends its bare marker with a newline and the GFM handler
 * appends the checkbox after that newline. Wrap only that handler so the
 * split marker and checkbox become one parseable task line.
 */
function gfmToMarkdownWithEmptyTasks(): Options {
  const gfm = gfmToMarkdown();
  return {
    ...gfm,
    extensions: gfm.extensions?.map((extension): Options => {
      const listItem = extension.handlers?.listItem;
      if (!listItem) return extension;

      return {
        ...extension,
        handlers: {
          ...extension.handlers,
          listItem(node, parent, state, info) {
            let value = listItem(node, parent, state, info);
            if (
              node.type !== "listItem" ||
              typeof node.checked !== "boolean" ||
              node.children[0]?.type !== "paragraph"
            ) {
              return value;
            }

            const splitEmptyTask = value.match(
              /^((?:[*+-]|\d+\.))\r?\n\[([ xX])\][ \t]*$/,
            );
            if (splitEmptyTask) {
              return `${splitEmptyTask[1]} [${splitEmptyTask[2]}] `;
            }

            value = value.replace(
              /^(?:[*+-]|\d+\.)(?=\r?\n|$)/,
              (marker) =>
                `${marker} [${node.checked ? "x" : " "}] `,
            );
            return value.replace(
              /^((?:[*+-]|\d+\.)[ \t]+\[[ xX]\])(?=\r?\n|$)/,
              "$1 ",
            );
          },
        },
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Text leaf → mdast phrasing content
// ---------------------------------------------------------------------------

function textToMdast(leaf: CustomText): PhrasingContent | PhrasingContent[] {
  // Inline code takes absolute precedence — markdown cannot nest marks inside code spans
  if (leaf.code) {
    const node: InlineCode = { type: "inlineCode", value: leaf.text };
    return node;
  }

  let node: PhrasingContent = { type: "text", value: leaf.text };

  if (leaf.italic) {
    node = { type: "emphasis", children: [node] };
  }
  if (leaf.bold) {
    node = { type: "strong", children: [node] };
  }
  if (leaf.strikethrough) {
    node = { type: "delete", children: [node] };
  }

  // Underline has no native markdown representation; emit as inline HTML
  // <u>…</u> so it roundtrips through save/reload.
  if (leaf.underline) {
    return [
      { type: "html", value: "<u>" } as unknown as PhrasingContent,
      node,
      { type: "html", value: "</u>" } as unknown as PhrasingContent,
    ];
  }

  // Superscript/subscript have no native markdown; emit as inline HTML
  // <sup>…</sup> / <sub>…</sub> so they roundtrip through save/reload.
  if (leaf.superscript) {
    return [
      { type: "html", value: "<sup>" } as unknown as PhrasingContent,
      node,
      { type: "html", value: "</sup>" } as unknown as PhrasingContent,
    ];
  }
  if (leaf.subscript) {
    return [
      { type: "html", value: "<sub>" } as unknown as PhrasingContent,
      node,
      { type: "html", value: "</sub>" } as unknown as PhrasingContent,
    ];
  }

  return node;
}

// ---------------------------------------------------------------------------
// Slate element → mdast node
// ---------------------------------------------------------------------------

function convertInlineChildren(children: Descendant[]): PhrasingContent[] {
  const result: PhrasingContent[] = [];
  for (const child of children) {
    if (SlateText.isText(child)) {
      const converted = textToMdast(child as CustomText);
      if (Array.isArray(converted)) {
        result.push(...converted);
      } else {
        result.push(converted);
      }
    } else {
      const el = child as CustomElement;
      switch (el.type) {
        case "inline-math": {
          const math: FolioInlineMathMdast = {
            type: "inlineMath",
            value: el.tex,
            data: {
              folioDelimiter: el.delimiter,
              folioSourceBody: el.tex,
            },
          };
          result.push(math as PhrasingContent);
          break;
        }
        case "link": {
          result.push({
            type: "link",
            url: el.url,
            children: convertInlineChildren(el.children),
          });
          break;
        }
        case "image": {
          result.push({
            type: "image",
            url: el.url,
            alt: el.alt,
            title: el.title ?? null,
          });
          break;
        }
        case "wikilink": {
          const wl: WikiLinkMdast = {
            type: "wikiLink",
            data: {
              permalink: el.target,
              alias: el.alias,
            },
          };
          result.push(wl as unknown as PhrasingContent);
          break;
        }
        case "block-ref": {
          result.push({
            type: "text",
            value: `((${el.blockId}))`,
          } as PhrasingContent);
          break;
        }
        case "footnote-ref": {
          result.push({
            type: "footnoteReference",
            identifier: el.identifier,
            label: el.identifier,
          } as unknown as PhrasingContent);
          break;
        }
        default:
          // Unexpected inline element — treat its children as inline text
          result.push(...convertInlineChildren((el as CustomElement).children));
      }
    }
  }
  return result;
}

function convertElement(node: CustomElement): RootContent {
  if (node.type === "math-block") {
    const math: FolioMathMdast = {
      type: "math",
      value: node.tex,
      data: {
        folioDelimiter: node.delimiter,
        folioSourceBody: node.tex,
      },
    };
    return math as RootContent;
  }
  const desc = getDescriptor(node.type);
  if (desc?.toMdast) return desc.toMdast(node as never, ctx);
  // Fallback mirrors the old default: serialize children as a paragraph.
  return { type: "paragraph", children: convertInlineChildren(node.children) };
}

function convertListItem(
  node: CustomElement & { type: "list-item" },
): ListItem {
  const li: ListItem = {
    type: "listItem",
    spread: false,
    children: convertBlockChildren(node.children),
  };

  // Propagate checkbox state for GFM task list items
  if (node.checked === true || node.checked === false) {
    li.checked = node.checked;
  }

  // Append properties and blockId to the last text node in the list item's
  // first paragraph (if any). We need to find the deepest phrasing content.
  appendBlockMetadataToListItem(li, node);

  return li;
}

// ---------------------------------------------------------------------------
// Block metadata serialization helpers
// ---------------------------------------------------------------------------

/**
 * Build the suffix string for properties and blockId.
 * Uses inline HTML node to bypass markdown escaping of brackets.
 */
function buildMetadataSuffix(element: {
  properties?: Record<string, string>;
  blockId?: string;
}): string {
  let suffix = "";
  if (element.properties) {
    for (const [key, value] of Object.entries(element.properties)) {
      suffix += ` [${key}:: ${value}]`;
    }
  }
  if (element.blockId) {
    suffix += ` ^${element.blockId}`;
  }
  return suffix;
}

/**
 * Append properties/blockId suffix as an inline HTML node to a PhrasingContent[].
 * Using HTML type prevents toMarkdown from escaping brackets in [key:: value].
 */
function appendBlockMetadataSuffix(
  children: PhrasingContent[],
  element: { properties?: Record<string, string>; blockId?: string },
): void {
  const suffix = buildMetadataSuffix(element);
  if (!suffix) return;
  // Append as inline HTML to bypass bracket escaping
  children.push({ type: "html", value: suffix } as unknown as PhrasingContent);
}

/**
 * Append properties/blockId to the content of a list item's first paragraph.
 */
function appendBlockMetadataToListItem(
  li: ListItem,
  slateNode: { properties?: Record<string, string>; blockId?: string },
): void {
  const suffix = buildMetadataSuffix(slateNode);
  if (!suffix) return;

  // Find the first paragraph in the list item and append as inline HTML
  for (const child of li.children) {
    if (child.type === "paragraph") {
      child.children.push({
        type: "html",
        value: suffix,
      } as unknown as PhrasingContent);
      return;
    }
  }
  // No paragraph found — add one with just the suffix
  li.children.push({
    type: "paragraph",
    children: [
      { type: "html", value: suffix.trimStart() } as unknown as PhrasingContent,
    ],
  });
}

function convertBlockChildren(children: Descendant[]): Array<BlockContent> {
  const result: Array<BlockContent> = [];
  for (const child of children) {
    if (SlateText.isText(child)) {
      // Stray text at block level — wrap in paragraph
      const leaf = child as CustomText;
      if (leaf.text !== "") {
        const converted = textToMdast(leaf);
        result.push({
          type: "paragraph",
          children: Array.isArray(converted) ? converted : [converted],
        });
      }
    } else {
      result.push(convertElement(child as CustomElement) as BlockContent);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Serialization context — recursive helpers handed to each descriptor.toMdast
// ---------------------------------------------------------------------------

const ctx: SerializeCtx = {
  inlineChildren: convertInlineChildren,
  blockChildren: convertBlockChildren,
  appendBlockMetadata: appendBlockMetadataSuffix,
  listItem: convertListItem,
};

// ---------------------------------------------------------------------------
// Public API
function withoutBaseEmbedTrailingSentinel(
  nodes: Descendant[],
): Descendant[] {
  if (nodes.length < 2) return nodes;
  const base = nodes[nodes.length - 2];
  const sentinel = nodes[nodes.length - 1];
  if (
    SlateText.isText(base) ||
    base.type !== "base-embed" ||
    SlateText.isText(sentinel) ||
    sentinel.type !== "paragraph" ||
    sentinel.baseEmbedTrailingSentinel !== true ||
    Object.keys(sentinel).length !== 3 ||
    sentinel.children.length !== 1
  ) {
    return nodes;
  }
  const child = sentinel.children[0];
  if (
    !SlateText.isText(child) ||
    child.text !== "" ||
    Object.keys(child).length !== 1
  ) {
    return nodes;
  }
  return nodes.slice(0, -1);
}

// ---------------------------------------------------------------------------

/**
 * Convert a Slate `Descendant[]` tree to a markdown string.
 */
export function slateToMdast(nodes: Descendant[]): string {
  const root: Root = {
    type: "root",
    children: convertBlockChildren(
      withoutBaseEmbedTrailingSentinel(nodes),
    ) as RootContent[],
  };

  const markdown = toMarkdown(root as Nodes, {
    bullet: "*",
    rule: "-",
    extensions: [
      baseFenceToMarkdown(),
      folioMathToMarkdown(),
      gfmToMarkdownWithEmptyTasks(),
      wikiLinkToMarkdownExtension(),
      singleTildeStrikethroughExtension(),
    ],
  });
  const last = root.children.at(-1) as unknown as
    | BaseFenceMdast
    | undefined;
  if (
    last?.type === "baseFence" &&
    !/[\r\n]$/.test(last.rawBlock)
  ) {
    return markdown.slice(0, -1);
  }
  return markdown;
}
