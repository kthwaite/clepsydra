import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import wikiLinkPlugin from "remark-wiki-link";
import type { Descendant } from "slate";
import { unified } from "unified";
import type {
  CustomText,
  LinkElement,
  ListItemElement,
  WikilinkElement,
} from "#/editor/types";

// Re-export for the barrel
export type { Descendant };

/**
 * Marks accumulator carried through inline/phrasing content conversion.
 */
interface Marks {
  bold?: true;
  italic?: true;
  code?: true;
}

/**
 * The remark-wiki-link plugin produces nodes with this shape.
 * Not part of the standard mdast types, so we define it here.
 */
interface WikiLinkMdastNode {
  type: "wikiLink";
  value: string;
  data: {
    alias: string;
    permalink: string;
    exists: boolean;
    hName: string;
    hProperties: Record<string, unknown>;
    hChildren: Array<{ type: string; value: string }>;
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(wikiLinkPlugin, { aliasDivider: "|" });

/**
 * Convert a markdown string to a Slate Descendant[] tree.
 *
 * Pure function: no side effects, no React dependencies.
 */
export function mdastToSlate(markdown: string): Descendant[] {
  const mdast = processor.parse(markdown);
  const tree = processor.runSync(mdast) as Root;

  const result = convertChildren(tree.children);

  // Slate invariant: document must have at least one block
  if (result.length === 0) {
    return [{ type: "paragraph", children: [{ text: "" }] }];
  }

  return result;
}

/**
 * Convert an array of mdast block-level nodes to Slate Descendant[].
 */
function convertChildren(nodes: RootContent[]): Descendant[] {
  const result: Descendant[] = [];
  for (const node of nodes) {
    const converted = convertBlockNode(node);
    if (converted != null) {
      result.push(converted);
    }
  }
  return result;
}

/**
 * Convert a single mdast block-level node to a Slate element.
 * Returns null for node types we choose to skip (e.g., yaml, html, definition).
 */
function convertBlockNode(node: RootContent): Descendant | null {
  switch (node.type) {
    case "paragraph":
      return {
        type: "paragraph",
        children: convertPhrasingContent(node.children, {}),
      };

    case "heading":
      return {
        type: "heading",
        level: node.depth,
        children: convertPhrasingContent(node.children, {}),
      };

    case "code":
      return {
        type: "code-block",
        ...(node.lang ? { language: node.lang } : {}),
        children: [{ text: node.value }],
      };

    case "blockquote":
      return {
        type: "blockquote",
        children: convertChildren(node.children as RootContent[]),
      };

    case "list":
      return {
        type: node.ordered ? "numbered-list" : "bulleted-list",
        children: node.children.map((item) => convertListItem(item)),
      };

    case "thematicBreak":
      return {
        type: "thematic-break",
        children: [{ text: "" }],
      };

    // Node types we intentionally skip
    case "html":
    case "definition":
    case "footnoteDefinition":
    case "yaml":
    case "table":
      return null;

    default:
      // Unknown block node: skip
      return null;
  }
}

/**
 * Convert an mdast listItem to a Slate list-item element.
 */
function convertListItem(node: {
  type: "listItem";
  children: RootContent[];
}): ListItemElement {
  return {
    type: "list-item",
    children: convertChildren(node.children as RootContent[]),
  };
}

/**
 * Convert an array of mdast phrasing content nodes into Slate inline nodes
 * (CustomText and inline elements like wikilinks and links).
 *
 * The `marks` parameter accumulates formatting (bold, italic, code) as we
 * recurse through strong/emphasis/inlineCode wrappers.
 */
function convertPhrasingContent(
  nodes: readonly (RootContent | WikiLinkMdastNode)[],
  marks: Marks,
): Descendant[] {
  const result: Descendant[] = [];

  for (const node of nodes) {
    const converted = convertPhrasingNode(node, marks);
    for (const item of converted) {
      result.push(item);
    }
  }

  // Slate invariant: every element must have at least one child
  if (result.length === 0) {
    result.push(textNode("", marks));
  }

  return result;
}

/**
 * Convert a single mdast phrasing node to one or more Slate inline nodes.
 */
function convertPhrasingNode(
  node: RootContent | WikiLinkMdastNode,
  marks: Marks,
): Descendant[] {
  switch (node.type) {
    case "text":
      return [textNode(node.value, marks)];

    case "strong":
      return convertPhrasingContent(
        node.children as (RootContent | WikiLinkMdastNode)[],
        { ...marks, bold: true },
      );

    case "emphasis":
      return convertPhrasingContent(
        node.children as (RootContent | WikiLinkMdastNode)[],
        { ...marks, italic: true },
      );

    case "inlineCode":
      return [textNode(node.value, { ...marks, code: true })];

    case "link":
      return [
        {
          type: "link",
          url: node.url,
          children: convertPhrasingContent(
            node.children as (RootContent | WikiLinkMdastNode)[],
            marks,
          ),
        } satisfies LinkElement as unknown as Descendant,
      ];

    case "wikiLink": {
      const wl = node as unknown as WikiLinkMdastNode;
      const target = wl.value;
      const alias = wl.data.alias;
      const element: WikilinkElement = {
        type: "wikilink",
        target,
        // Only include alias when it differs from the target
        ...(alias !== target ? { alias } : {}),
        children: [{ text: "" }],
      };
      return [element as unknown as Descendant];
    }

    case "break":
      return [textNode("\n", marks)];

    case "delete":
      // Strikethrough: we don't have a strikethrough mark, so just render the text
      return convertPhrasingContent(
        (node as { children: RootContent[] }).children as (
          | RootContent
          | WikiLinkMdastNode
        )[],
        marks,
      );

    case "image":
      // Images are not supported in the current Slate schema; render alt text
      return [textNode(node.alt ?? "", marks)];

    case "footnoteReference":
      // Not supported in current schema
      return [];

    case "html":
      // Inline HTML — render as text
      return [textNode(node.value, marks)];

    default:
      return [];
  }
}

/**
 * Create a Slate CustomText node with the given marks.
 * Only includes mark properties that are `true` to keep output clean.
 */
function textNode(text: string, marks: Marks): CustomText {
  const node: CustomText = { text };
  if (marks.bold) node.bold = true;
  if (marks.italic) node.italic = true;
  if (marks.code) node.code = true;
  return node;
}
