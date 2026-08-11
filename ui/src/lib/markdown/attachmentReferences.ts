import type { Image, Link, Nodes, Root } from "mdast";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { attachmentUrl } from "#/api/attachments";

export interface AttachmentReference {
  path: string;
  label: string;
  image: boolean;
}

const parser = unified().use(remarkParse).use(remarkGfm);
const attachmentUrlPrefix = attachmentUrl("");

function referenceFromNode(node: Link | Image): AttachmentReference | null {
  let decodedUrl: string;
  try {
    decodedUrl = decodeURIComponent(node.url);
  } catch {
    return null;
  }

  if (!decodedUrl.startsWith(attachmentUrlPrefix)) return null;
  const path = decodedUrl.slice(attachmentUrlPrefix.length);
  if (!path) return null;

  return {
    path,
    label: toString(node),
    image: node.type === "image",
  };
}

export function attachmentReferences(markdown: string): AttachmentReference[] {
  const tree = parser.parse(markdown) as Root;
  const references: AttachmentReference[] = [];
  const seenPaths = new Set<string>();

  function visit(node: Nodes): void {
    if (node.type === "link" || node.type === "image") {
      const reference = referenceFromNode(node);
      if (reference && !seenPaths.has(reference.path)) {
        seenPaths.add(reference.path);
        references.push(reference);
      }
    }

    if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  }

  visit(tree);
  return references;
}
