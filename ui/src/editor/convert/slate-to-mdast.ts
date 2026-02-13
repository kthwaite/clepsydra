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
// Text leaf → mdast phrasing content
// ---------------------------------------------------------------------------

function textToMdast(leaf: CustomText): PhrasingContent {
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

  return node;
}

// ---------------------------------------------------------------------------
// Slate element → mdast node
// ---------------------------------------------------------------------------

function convertInlineChildren(children: Descendant[]): PhrasingContent[] {
  const result: PhrasingContent[] = [];
  for (const child of children) {
    if (SlateText.isText(child)) {
      result.push(textToMdast(child as CustomText));
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
      const p: Paragraph = {
        type: "paragraph",
        children: convertInlineChildren(node.children),
      };
      return p;
    }

    case "heading": {
      const h: Heading = {
        type: "heading",
        depth: node.level,
        children: convertInlineChildren(node.children),
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
  return li;
}

function convertBlockChildren(children: Descendant[]): Array<BlockContent> {
  const result: Array<BlockContent> = [];
  for (const child of children) {
    if (SlateText.isText(child)) {
      // Stray text at block level — wrap in paragraph
      const leaf = child as CustomText;
      if (leaf.text !== "") {
        result.push({
          type: "paragraph",
          children: [textToMdast(leaf)],
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
    extensions: [gfmToMarkdown(), wikiLinkToMarkdownExtension()],
  });
}
