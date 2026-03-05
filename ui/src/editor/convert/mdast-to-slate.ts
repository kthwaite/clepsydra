import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import wikiLinkPlugin from "remark-wiki-link";
import type { Descendant } from "slate";
import { unified } from "unified";
import type {
  BlockRefElement,
  CustomElement,
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
 * When `extractMetadata` is true, block-level metadata (^blockId, [key:: value])
 * is extracted from paragraphs and headings.
 */
function convertChildren(
  nodes: RootContent[],
  extractMetadata = true,
): Descendant[] {
  const result: Descendant[] = [];
  for (const node of nodes) {
    const converted = convertBlockNode(node, extractMetadata);
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
function convertBlockNode(
  node: RootContent,
  extractMetadata = true,
): Descendant | null {
  switch (node.type) {
    case "paragraph": {
      const el = {
        type: "paragraph" as const,
        children: convertPhrasingContent(node.children, {}),
      };
      return extractMetadata ? extractBlockMetadata(el) : el;
    }

    case "heading": {
      const el = {
        type: "heading" as const,
        level: node.depth,
        children: convertPhrasingContent(node.children, {}),
      };
      return extractMetadata ? extractBlockMetadata(el) : el;
    }

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
 * Metadata extraction is done at the list-item level (not on child paragraphs).
 */
function convertListItem(node: {
  type: "listItem";
  checked?: boolean | null;
  children: RootContent[];
}): ListItemElement {
  // Convert children WITHOUT metadata extraction — we extract at the list-item level
  const el: ListItemElement = {
    type: "list-item",
    children: convertChildren(node.children as RootContent[], false),
  };

  // Propagate checkbox state from GFM task list items
  if (node.checked === true) {
    el.checked = true;
  } else if (node.checked === false) {
    el.checked = false;
  }
  // node.checked === null or undefined → leave checked off

  return extractBlockMetadata(el) as ListItemElement;
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
      return splitBlockRefs(node.value, marks);

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

/**
 * Pattern for block references: ((10-12 alphanumeric chars))
 */
const BLOCK_REF_RE = /\(\(([A-Za-z0-9]{10,12})\)\)/g;

/**
 * Split a text value into text nodes and BlockRefElement nodes.
 * If no block references are found, returns a single text node.
 */
function splitBlockRefs(value: string, marks: Marks): Descendant[] {
  const result: Descendant[] = [];
  let lastIndex = 0;
  BLOCK_REF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = BLOCK_REF_RE.exec(value)) !== null) {
    // Text before the match
    if (match.index > lastIndex) {
      result.push(textNode(value.slice(lastIndex, match.index), marks));
    }
    // The block reference element
    const element: BlockRefElement = {
      type: "block-ref",
      blockId: match[1],
      children: [{ text: "" }],
    };
    result.push(element as unknown as Descendant);
    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last match (or entire string if no matches)
  if (lastIndex < value.length) {
    result.push(textNode(value.slice(lastIndex), marks));
  }

  // If nothing was produced (empty string, no matches), return a single text node
  if (result.length === 0) {
    result.push(textNode("", marks));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Post-processing: extract block IDs and inline properties from text nodes
// ---------------------------------------------------------------------------

/** Pattern for block IDs: whitespace + ^ + 10-12 alphanumeric chars at end of text */
const BLOCK_ID_RE = /\s+\^([A-Za-z0-9]{10,12})$/;

/**
 * Pattern for inline properties: [key:: value]
 *
 * Known limitation: URL values (e.g. `[url:: https://example.com]`) fail to
 * parse because remark-gfm auto-links the URL before this regex runs,
 * fragmenting the `[key:: value]` text across multiple AST nodes (text + link
 * + text). Fixing this would require either disabling auto-linking globally
 * (breaking other features) or pre-processing raw markdown (fragile). Accepted
 * as a v2 concern — URL values in inline properties are uncommon in practice.
 */
const INLINE_PROP_RE = /\[([A-Za-z_][\w-]*)::[ \t]+([^\]]+)\]/g;

const NESTED_LIST_TYPES: ReadonlySet<string> = new Set([
  "bulleted-list",
  "numbered-list",
]);

function isTextNode(node: Descendant): node is CustomText {
  return "text" in node;
}

function isNestedList(node: Descendant): boolean {
  return (
    !isTextNode(node) && NESTED_LIST_TYPES.has((node as CustomElement).type)
  );
}

/**
 * Find the last CustomText node in a Descendant[] tree (depth-first, rightmost).
 */
function findLastTextNode(children: Descendant[]): CustomText | null {
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (isTextNode(child)) {
      return child;
    }
    const el = child as CustomElement;
    if (el.children) {
      const found = findLastTextNode(el.children);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Collect all CustomText nodes from a Descendant[] tree (in order).
 */
function collectTextNodes(children: Descendant[]): CustomText[] {
  const result: CustomText[] = [];
  for (const child of children) {
    if (isTextNode(child)) {
      result.push(child);
    } else {
      const el = child as CustomElement;
      if (el.children) {
        result.push(...collectTextNodes(el.children));
      }
    }
  }
  return result;
}

/**
 * Post-process a block element to extract ^blockId and [key:: value]
 * inline properties from its text content. Mutates the element in place
 * and returns it for convenience.
 *
 * For list-item elements, only direct paragraph children are searched —
 * nested lists (bulleted-list, numbered-list) are excluded so that a
 * child item's text is never mistaken for the parent's block metadata.
 */
function extractBlockMetadata<T extends Descendant>(element: T): T {
  const el = element as unknown as CustomElement & {
    blockId?: string;
    properties?: Record<string, string>;
  };

  // For list-items, restrict metadata search to non-list children (paragraphs)
  // so nested list text doesn't contaminate the parent's metadata extraction.
  const searchChildren =
    el.type === "list-item"
      ? el.children.filter((c) => !isNestedList(c))
      : el.children;

  // 1. Extract inline properties from all text nodes
  const allTextNodes = collectTextNodes(searchChildren);
  const properties: Record<string, string> = {};
  for (const textChild of allTextNodes) {
    INLINE_PROP_RE.lastIndex = 0;
    const matches: Array<{ full: string; key: string; value: string }> = [];
    let match: RegExpExecArray | null;
    while ((match = INLINE_PROP_RE.exec(textChild.text)) !== null) {
      matches.push({ full: match[0], key: match[1], value: match[2] });
    }
    for (const m of matches) {
      properties[m.key] = m.value;
      textChild.text = textChild.text.replace(m.full, "");
    }
  }
  if (Object.keys(properties).length > 0) {
    el.properties = properties;
  }

  // 2. Extract block ID from the last text node (within search scope)
  const lastText = findLastTextNode(searchChildren);
  if (lastText) {
    const blockIdMatch = BLOCK_ID_RE.exec(lastText.text);
    if (blockIdMatch) {
      el.blockId = blockIdMatch[1];
      lastText.text = lastText.text.slice(
        0,
        lastText.text.length - blockIdMatch[0].length,
      );
    }
  }

  // 3. Clean up trailing whitespace left by property/blockId removal
  const lastTextAfter = findLastTextNode(searchChildren);
  if (lastTextAfter && (el.blockId || el.properties)) {
    lastTextAfter.text = lastTextAfter.text.trimEnd();
  }

  return element;
}
