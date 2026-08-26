import type {
  Image,
  ImageReference,
  Link,
  LinkReference,
  Nodes,
  Root,
} from "mdast";
import { toString as markdownToString } from "mdast-util-to-string";
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

export function canonicalAttachmentPath(path: string): string {
  return path.normalize("NFC");
}

function attachmentPathFromUrl(url: string): string | null {
  const suffixIndex = url.search(/[?#]/);
  const destination = suffixIndex === -1 ? url : url.slice(0, suffixIndex);
  let decodedUrl: string;
  try {
    decodedUrl = decodeURIComponent(destination);
  } catch {
    return null;
  }

  if (!decodedUrl.startsWith(attachmentUrlPrefix)) return null;
  const path = decodedUrl.slice(attachmentUrlPrefix.length);
  return path ? canonicalAttachmentPath(path) : null;
}

type ReferenceNode = Link | Image | LinkReference | ImageReference;

function referenceFromNode(
  node: ReferenceNode,
  url: string,
): AttachmentReference | null {
  const path = attachmentPathFromUrl(url);
  if (!path) return null;

  return {
    path,
    label: markdownToString(node),
    image: node.type === "image" || node.type === "imageReference",
  };
}

export function attachmentReferences(markdown: string): AttachmentReference[] {
  const tree = parser.parse(markdown) as Root;
  const definitions = new Map<string, string>();
  const references: AttachmentReference[] = [];
  const seenPaths = new Set<string>();

  function collectDefinitions(node: Nodes): void {
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
    if ("children" in node) {
      for (const child of node.children) collectDefinitions(child);
    }
  }

  function visit(node: Nodes): void {
    let url: string | undefined;
    if (node.type === "link" || node.type === "image") {
      url = node.url;
    } else if (
      node.type === "linkReference" ||
      node.type === "imageReference"
    ) {
      url = definitions.get(node.identifier);
    }

    if (url) {
      const reference = referenceFromNode(node as ReferenceNode, url);
      if (reference && !seenPaths.has(reference.path)) {
        seenPaths.add(reference.path);
        references.push(reference);
      }
    }

    if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  }

  collectDefinitions(tree);
  visit(tree);
  return references;
}
