import type {
  BlockContent,
  Code,
  Heading,
  InlineCode,
  List,
  ListItem,
  Nodes,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  ThematicBreak,
} from "mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import type { Options } from "mdast-util-to-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import type { Descendant } from "slate";
import { Text as SlateText } from "slate";
import type { CustomElement, CustomText } from "#/editor/types";

// ---------------------------------------------------------------------------
// Custom wikiLink mdast node (not in the standard mdast typings)
// ---------------------------------------------------------------------------

interface WikiLinkMdast {
  type: "wikiLink";
  data: {
    alias?: string;
    permalink: string;
  };
}

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
        case "link": {
          result.push({
            type: "link",
            url: el.url,
            children: convertInlineChildren(el.children),
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
        default:
          // Unexpected inline element — treat its children as inline text
          result.push(...convertInlineChildren((el as CustomElement).children));
      }
    }
  }
  return result;
}

function convertElement(node: CustomElement): RootContent {
  switch (node.type) {
    case "paragraph": {
      const children = convertInlineChildren(node.children);
      appendBlockMetadataSuffix(children, node);
      const p: Paragraph = {
        type: "paragraph",
        children,
      };
      return p;
    }

    case "heading": {
      const children = convertInlineChildren(node.children);
      appendBlockMetadataSuffix(children, node);
      const h: Heading = {
        type: "heading",
        depth: node.level,
        children,
      };
      return h;
    }

    case "code-block": {
      const value = node.children.map((c) => (c as CustomText).text).join("");
      const code: Code = {
        type: "code",
        lang: node.language ?? null,
        value,
      };
      return code;
    }

    case "blockquote": {
      return {
        type: "blockquote",
        children: convertBlockChildren(node.children),
      };
    }

    case "bulleted-list": {
      const list: List = {
        type: "list",
        ordered: false,
        spread: false,
        children: node.children.map(convertListItem),
      };
      return list;
    }

    case "numbered-list": {
      const list: List = {
        type: "list",
        ordered: true,
        start: 1,
        spread: false,
        children: node.children.map(convertListItem),
      };
      return list;
    }

    case "thematic-break": {
      const tb: ThematicBreak = { type: "thematicBreak" };
      return tb;
    }

    case "list-item": {
      // list-item at top level is unusual; wrap in unordered list
      const li = convertListItem(node);
      const list: List = {
        type: "list",
        ordered: false,
        spread: false,
        children: [li],
      };
      return list;
    }

    case "link": {
      // A link at block level — wrap in paragraph
      const p: Paragraph = {
        type: "paragraph",
        children: [
          {
            type: "link",
            url: node.url,
            children: convertInlineChildren(node.children),
          },
        ],
      };
      return p;
    }

    case "wikilink": {
      // A wikilink at block level — wrap in paragraph
      const wl: WikiLinkMdast = {
        type: "wikiLink",
        data: {
          permalink: node.target,
          alias: node.alias,
        },
      };
      const p: Paragraph = {
        type: "paragraph",
        children: [wl as unknown as PhrasingContent],
      };
      return p;
    }

    case "block-ref": {
      // A block-ref at block level — wrap in paragraph
      const p: Paragraph = {
        type: "paragraph",
        children: [
          { type: "text", value: `((${node.blockId}))` } as PhrasingContent,
        ],
      };
      return p;
    }
  }
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a Slate `Descendant[]` tree to a markdown string.
 */
export function slateToMdast(nodes: Descendant[]): string {
  const root: Root = {
    type: "root",
    children: convertBlockChildren(nodes) as RootContent[],
  };

  return toMarkdown(root as Nodes, {
    bullet: "*",
    rule: "-",
    extensions: [
      gfmToMarkdown(),
      wikiLinkToMarkdownExtension(),
      singleTildeStrikethroughExtension(),
    ],
  });
}
