import type { PhrasingContent, Root, Text } from "mdast";

export const BLOCK_REFERENCE_SCHEME = "clepsydra-block:";

const BLOCK_ID_PATTERN = /^[A-Za-z0-9]{10,12}$/;
const BLOCK_REFERENCE_PATTERN = /\(\(([A-Za-z0-9]{10,12})\)\)/g;
const OPAQUE_NODE_TYPES: Record<string, true> = {
  code: true,
  inlineCode: true,
  link: true,
  linkReference: true,
  html: true,
};

interface MutableNode {
  type: string;
  children?: MutableNode[];
  value?: string;
}

export function blockIdFromHref(href: string): string | null {
  if (!href.startsWith(BLOCK_REFERENCE_SCHEME)) return null;

  const blockId = href.slice(BLOCK_REFERENCE_SCHEME.length);
  return BLOCK_ID_PATTERN.test(blockId) ? blockId : null;
}


function splitText(value: string): PhrasingContent[] | null {
  const children: PhrasingContent[] = [];
  let endOfLastMatch = 0;

  for (const match of value.matchAll(BLOCK_REFERENCE_PATTERN)) {
    const matchStart = match.index;
    if (matchStart > endOfLastMatch) {
      children.push({
        type: "text",
        value: value.slice(endOfLastMatch, matchStart),
      } satisfies Text);
    }

    children.push({
      type: "link",
      url: `${BLOCK_REFERENCE_SCHEME}${match[1]}`,
      children: [{ type: "text", value: match[0] }],
    });
    endOfLastMatch = matchStart + match[0].length;
  }

  if (children.length === 0) return null;
  if (endOfLastMatch < value.length) {
    children.push({
      type: "text",
      value: value.slice(endOfLastMatch),
    } satisfies Text);
  }
  return children;
}


function transformChildren(parent: MutableNode): void {
  const children = parent.children;
  if (!children) return;

  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (child.type === "text" && typeof child.value === "string") {
      const replacement = splitText(child.value);
      if (replacement) {
        children.splice(
          index,
          1,
          ...(replacement as unknown as MutableNode[]),
        );
        index += replacement.length - 1;
      }
      continue;
    }

    if (
      OPAQUE_NODE_TYPES[child.type] !== true &&
      !child.type.startsWith("mdx")
    ) {
      transformChildren(child);
    }
  }
}

export function remarkBlockReferences(): (tree: Root) => void {
  return (tree) => transformChildren(tree as unknown as MutableNode);
}
