import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import wikiLinkPlugin from "remark-wiki-link";
import type { Descendant } from "slate";
import { unified } from "unified";
import {
  type ConversationMarker,
  parseConversationMarker,
} from "#/editor/conversation/marker";
import { inlinePropertyScanner } from "#/editor/properties";
import type {
  BlockRefElement,
  CustomElement,
  CustomText,
  ImageElement,
  InlineMathElement,
  LinkElement,
  ListItemElement,
  MathBlockElement,
  TableAlign,
  TableCellElement,
  TableElement,
  TableRowElement,
  WikilinkElement,
} from "#/editor/types";
import { remarkFolioMath } from "#/lib/markdown/folioMath";
import { baseEmbedFromCode } from "./baseEmbedMarkdown";
import type { FolioInlineMathMdast, FolioMathMdast } from "./mdastTypes";

// Re-export for the barrel
export type { Descendant };

/**
 * Marks accumulator carried through inline/phrasing content conversion.
 */
interface Marks {
  bold?: true;
  italic?: true;
  underline?: true;
  code?: true;
  strikethrough?: true;
  superscript?: true;
  subscript?: true;
}

interface ConversionContext {
  blockRefsEnabled: boolean;
  definitions: ReadonlyMap<string, string>;
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
  .use(wikiLinkPlugin, { aliasDivider: "|" })
  .use(remarkFolioMath);

/**
 * Convert a markdown string to a Slate Descendant[] tree.
 *
 * Pure function: no side effects, no React dependencies.
 */
export function mdastToSlate(markdown: string): Descendant[] {
  const tree = processor.runSync(processor.parse(markdown), {
    value: markdown,
  }) as Root;
  const definitions = new Map<string, string>();
  for (const node of tree.children) {
    if (node.type === "definition") {
      definitions.set(node.identifier, node.url);
    }
  }
  const context: ConversionContext = {
    blockRefsEnabled: true,
    definitions,
  };

  const result = convertChildren(tree.children, markdown, context, true, true);

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
  source: string,
  context: ConversionContext,
  extractMetadata = true,
  recognizeJournalTime = false,
  insideBlockquote = false,
): Descendant[] {
  const result: Descendant[] = [];
  for (const node of nodes) {
    const converted = convertBlockNode(
      node,
      source,
      context,
      extractMetadata,
      recognizeJournalTime,
      insideBlockquote,
    );
    if (converted != null) {
      result.push(converted);
    }
  }
  return result;
}

function conversationMarkerFromBlockquote(
  node: Extract<RootContent, { type: "blockquote" }>,
): { marker: ConversationMarker; body: RootContent[] } | null {
  const first = node.children[0];
  if (!first || first.type !== "paragraph" || first.children.length === 0) {
    return null;
  }
  const firstChild = first.children[0];
  if (firstChild.type !== "text" && firstChild.type !== "html") return null;

  const marker = parseConversationMarker(firstChild.value);
  if (marker && first.children.length === 1) {
    return { marker, body: node.children.slice(1) as RootContent[] };
  }

  // The capture renderer emits `> marker` immediately followed by `> body`.
  // CommonMark can therefore merge the marker and first body line into one
  // paragraph, including separate phrasing children for formatting.
  if (firstChild.type !== "text") return null;
  const lineEnd = firstChild.value.indexOf("\n");
  if (lineEnd < 0) return null;
  const prefixMarker = parseConversationMarker(
    firstChild.value.slice(0, lineEnd),
  );
  if (!prefixMarker) return null;

  const bodyChildren = first.children.slice(1);
  const remainder = firstChild.value.slice(lineEnd + 1);
  if (remainder) {
    bodyChildren.unshift({ type: "text", value: remainder });
  }
  const body = node.children.slice(1) as RootContent[];
  if (bodyChildren.length > 0) {
    body.unshift({ type: "paragraph", children: bodyChildren });
  }
  return { marker: prefixMarker, body };
}

/**
 * Convert a single mdast block-level node to a Slate element.
 * Returns null for node types we choose to skip (e.g., yaml, html, definition).
 */
function convertBlockNode(
  node: RootContent,
  source: string,
  context: ConversionContext,
  extractMetadata = true,
  recognizeJournalTime = false,
  insideBlockquote = false,
): Descendant | null {
  switch (node.type) {
    case "paragraph": {
      const el = {
        type: "paragraph" as const,
        children: convertPhrasingContent(node.children, {}, context),
      };
      return extractMetadata ? extractBlockMetadata(el) : el;
    }

    case "heading": {
      const onlyChild = node.children.length === 1 ? node.children[0] : null;
      if (
        recognizeJournalTime &&
        node.depth === 2 &&
        onlyChild?.type === "text" &&
        /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(onlyChild.value)
      ) {
        return {
          type: "journal-time",
          time: onlyChild.value,
          children: [{ text: "" }],
        };
      }
      const el = {
        type: "heading" as const,
        level: node.depth,
        children: convertPhrasingContent(node.children, {}, context),
      };
      return extractMetadata ? extractBlockMetadata(el) : el;
    }

    case "code": {
      const baseEmbed = baseEmbedFromCode(node, source);
      if (baseEmbed) return baseEmbed;
      const blockIdMatch = CODE_BLOCK_ID_RE.exec(node.value);
      return {
        type: "code-block",
        ...(node.lang ? { language: node.lang } : {}),
        ...(blockIdMatch ? { blockId: blockIdMatch[1] } : {}),
        children: [
          {
            text: blockIdMatch
              ? node.value.slice(0, blockIdMatch.index)
              : node.value,
          },
        ],
      };
    }

    case "blockquote": {
      const conversation = conversationMarkerFromBlockquote(node);
      if (conversation) {
        const children = convertChildren(
          conversation.body,
          source,
          context,
          true,
          false,
          true,
        );
        return {
          type: "conversation-turn",
          role: conversation.marker.role,
          source: conversation.marker.source,
          ...(conversation.marker.sequence === null
            ? {}
            : { sourceSequence: conversation.marker.sequence }),
          ...(conversation.marker.timestamp === null
            ? {}
            : { timestamp: conversation.marker.timestamp }),
          origin: conversation.marker.origin,
          children:
            children.length > 0
              ? children
              : [{ type: "paragraph", children: [{ text: "" }] }],
        };
      }
      return {
        type: "blockquote",
        children: convertChildren(
          node.children as RootContent[],
          source,
          context,
          true,
          false,
          true,
        ),
      };
    }

    case "list":
      return {
        type: node.ordered ? "numbered-list" : "bulleted-list",
        children: node.children.map((item) =>
          convertListItem(item, source, context),
        ),
      };

    case "math": {
      const math = node as FolioMathMdast;
      return {
        type: "math-block",
        tex: insideBlockquote
          ? math.data.folioSourceBody.replace(/^> ?/gm, "")
          : math.data.folioSourceBody,
        delimiter: math.data.folioDelimiter,
        children: [{ text: "" }],
      } satisfies MathBlockElement;
    }

    case "thematicBreak":
      return {
        type: "thematic-break",
        children: [{ text: "" }],
      };

    case "html": {
      // CommonMark may emit a block-level `html` node when an HTML tag opens on
      // a line of its own (e.g. `<u>\nfoo\n</u>`). The inline-html path that
      // strips `<u>` / `</u>` doesn't see these, so the content would otherwise
      // be silently dropped. Recognise an isolated `<u>...</u>` block and
      // re-emit it as a paragraph with the underline mark applied. Anything
      // else falls through to `null` (existing behaviour).
      const value = (node as { value: string }).value.trim();
      const underlineMatch = value.match(/^<u\s*>([\s\S]*?)<\/u\s*>$/i);
      if (underlineMatch) {
        const inner = underlineMatch[1];
        const el = {
          type: "paragraph" as const,
          children: [{ text: inner, underline: true } as CustomText],
        };
        return el;
      }
      const supMatch = value.match(/^<sup\s*>([\s\S]*?)<\/sup\s*>$/i);
      if (supMatch) {
        return {
          type: "paragraph" as const,
          children: [{ text: supMatch[1], superscript: true } as CustomText],
        };
      }
      const subMatch = value.match(/^<sub\s*>([\s\S]*?)<\/sub\s*>$/i);
      if (subMatch) {
        return {
          type: "paragraph" as const,
          children: [{ text: subMatch[1], subscript: true } as CustomText],
        };
      }
      return null;
    }

    case "footnoteDefinition":
      return {
        type: "footnote-def",
        identifier: (node as { identifier: string }).identifier,
        children: convertChildren(
          node.children as RootContent[],
          source,
          context,
        ),
      };

    case "table":
      return convertTable(node, context);

    // Node types we intentionally skip
    case "definition":
    case "yaml":
      return null;

    default:
      // Unknown block node: skip
      return null;
  }
}

/**
 * Convert a GFM table to a Slate table element.
 *
 * The delimiter row's alignment is kept on the table (authoritative for
 * serialization) and mirrored onto each cell so rendering needs no lookup;
 * the table normalizer maintains that mirror from then on. Rows keep their
 * source cell count — a short row stays short, exactly as GFM renders it.
 */
function convertTable(
  node: Extract<RootContent, { type: "table" }>,
  context: ConversionContext,
): TableElement | null {
  if (node.children.length === 0) return null;

  const align: (TableAlign | null)[] = (node.align ?? []).map((a) =>
    a === "left" || a === "center" || a === "right" ? a : null,
  );

  const rows = node.children.map(
    (row, rowIndex): TableRowElement => ({
      type: "table-row",
      children: row.children.map((cell, columnIndex): TableCellElement => {
        const columnAlign = align[columnIndex] ?? null;
        return {
          type: "table-cell",
          ...(rowIndex === 0 ? { header: true as const } : {}),
          ...(columnAlign ? { align: columnAlign } : {}),
          children: convertPhrasingContent(cell.children, {}, context),
        };
      }),
    }),
  );

  return {
    type: "table",
    ...(align.some((a) => a !== null) ? { align } : {}),
    children: rows,
  };
}

/**
 * Convert an mdast listItem to a Slate list-item element.
 * Metadata extraction is done at the list-item level (not on child paragraphs).
 */
function convertListItem(
  node: {
    type: "listItem";
    checked?: boolean | null;
    children: RootContent[];
  },
  source: string,
  context: ConversionContext,
): ListItemElement {
  // remark-gfm does not classify a terminal task marker with no following
  // content as a task; it leaves the marker as the paragraph's literal text.
  // Recover that conventional empty-task syntax at the conversion boundary.
  const onlyChild = node.children.length === 1 ? node.children[0] : undefined;
  if (
    node.checked == null &&
    onlyChild?.type === "paragraph" &&
    onlyChild.children.length === 1 &&
    onlyChild.children[0].type === "text"
  ) {
    const emptyTask = /^\[([ xX])\]$/.exec(onlyChild.children[0].value);
    if (emptyTask) {
      return {
        type: "list-item",
        checked: emptyTask[1] !== " ",
        children: [{ type: "paragraph", children: [{ text: "" }] }],
      };
    }
  }

  // Convert children WITHOUT metadata extraction — we extract at the list-item level
  const el: ListItemElement = {
    type: "list-item",
    children: convertChildren(
      node.children as RootContent[],
      source,
      context,
      false,
    ),
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
/** Match an isolated <u> opening tag (case-insensitive, optional whitespace). */
const U_OPEN_RE = /^<u\s*>$/i;
/** Match an isolated </u> closing tag (case-insensitive, optional whitespace). */
const U_CLOSE_RE = /^<\/u\s*>$/i;
/** Match an isolated <sup> opening tag (case-insensitive, optional whitespace). */
const SUP_OPEN_RE = /^<sup\s*>$/i;
/** Match an isolated </sup> closing tag (case-insensitive, optional whitespace). */
const SUP_CLOSE_RE = /^<\/sup\s*>$/i;
/** Match an isolated <sub> opening tag (case-insensitive, optional whitespace). */
const SUB_OPEN_RE = /^<sub\s*>$/i;
/** Match an isolated </sub> closing tag (case-insensitive, optional whitespace). */
const SUB_CLOSE_RE = /^<\/sub\s*>$/i;

function convertPhrasingContent(
  nodes: readonly (RootContent | WikiLinkMdastNode)[],
  marks: Marks,
  context: ConversionContext,
): Descendant[] {
  const result: Descendant[] = [];
  let underlineDepth = 0;
  let superscriptDepth = 0;
  let subscriptDepth = 0;

  for (const node of nodes) {
    if (node.type === "html") {
      const value = (node as { value: string }).value.trim();
      if (U_OPEN_RE.test(value)) {
        underlineDepth++;
        continue;
      }
      if (U_CLOSE_RE.test(value)) {
        if (underlineDepth > 0) underlineDepth--;
        continue;
      }
      if (SUP_OPEN_RE.test(value)) {
        superscriptDepth++;
        continue;
      }
      if (SUP_CLOSE_RE.test(value)) {
        if (superscriptDepth > 0) superscriptDepth--;
        continue;
      }
      if (SUB_OPEN_RE.test(value)) {
        subscriptDepth++;
        continue;
      }
      if (SUB_CLOSE_RE.test(value)) {
        if (subscriptDepth > 0) subscriptDepth--;
        continue;
      }
    }
    const effectiveMarks: Marks = {
      ...marks,
      ...(underlineDepth > 0 ? { underline: true } : {}),
      ...(superscriptDepth > 0 ? { superscript: true } : {}),
      ...(subscriptDepth > 0 ? { subscript: true } : {}),
    };
    const converted = convertPhrasingNode(node, effectiveMarks, context);
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
  context: ConversionContext,
): Descendant[] {
  switch (node.type) {
    case "text":
      return context.blockRefsEnabled
        ? splitBlockRefs(node.value, marks)
        : [textNode(node.value, marks)];

    case "strong":
      return convertPhrasingContent(
        node.children as (RootContent | WikiLinkMdastNode)[],
        { ...marks, bold: true },
        context,
      );

    case "emphasis":
      return convertPhrasingContent(
        node.children as (RootContent | WikiLinkMdastNode)[],
        { ...marks, italic: true },
        context,
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
            { ...context, blockRefsEnabled: false },
          ),
        } satisfies LinkElement as unknown as Descendant,
      ];

    case "linkReference": {
      const children = convertPhrasingContent(
        node.children as (RootContent | WikiLinkMdastNode)[],
        marks,
        { ...context, blockRefsEnabled: false },
      );
      const url = context.definitions.get(node.identifier);
      return url
        ? [
            {
              type: "link",
              url,
              children,
            } satisfies LinkElement as unknown as Descendant,
          ]
        : children;
    }

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

    case "inlineMath": {
      const math = node as FolioInlineMathMdast;
      return [
        {
          type: "inline-math",
          tex: math.data.folioSourceBody,
          delimiter: math.data.folioDelimiter,
          children: [{ text: "" }],
        } satisfies InlineMathElement as unknown as Descendant,
      ];
    }

    case "break":
      return [textNode("\n", marks)];

    case "delete":
      return convertPhrasingContent(
        (node as { children: RootContent[] }).children as (
          | RootContent
          | WikiLinkMdastNode
        )[],
        { ...marks, strikethrough: true },
        context,
      );

    case "image":
      return [
        {
          type: "image",
          url: node.url,
          alt: node.alt ?? "",
          ...(node.title ? { title: node.title } : {}),
          children: [{ text: "" }],
        } satisfies ImageElement as unknown as Descendant,
      ];

    case "footnoteReference":
      return [
        {
          type: "footnote-ref",
          identifier: (node as { identifier: string }).identifier,
          children: [{ text: "" }],
        } as unknown as Descendant,
      ];

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
  if (marks.underline) node.underline = true;
  if (marks.code) node.code = true;
  if (marks.strikethrough) node.strikethrough = true;
  if (marks.superscript) node.superscript = true;
  if (marks.subscript) node.subscript = true;
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
  let match = BLOCK_REF_RE.exec(value);

  while (match !== null) {
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
    match = BLOCK_REF_RE.exec(value);
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
const CODE_BLOCK_ID_RE = /\s+\^([A-Za-z0-9]{10,12})\s*$/;

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
    const scanner = inlinePropertyScanner();
    const matches: Array<{ full: string; key: string; value: string }> = [];
    let match = scanner.exec(textChild.text);
    while (match !== null) {
      matches.push({ full: match[0], key: match[1], value: match[2] });
      match = scanner.exec(textChild.text);
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
