import type { Root } from "mdast";
import { inlinePropertyScanner } from "#/editor/properties";
import type { PreviewTarget } from "#/lib/previewTarget";

/** Heading identity is NFC Unicode text, punctuation-free, with stable duplicate suffixes. */
function headingSlug(text: string): string {
  return text
    .replace(inlinePropertyScanner(), "")
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, "")
    .replace(/\s+/g, "-");
}

function nextHeadingId(text: string, used: Set<string>): string {
  const base = headingSlug(text);
  let id = base;
  let suffix = 0;
  while (used.has(id)) id = `${base}-${++suffix}`;
  used.add(id);
  return id;
}

/** Resolves only within the supplied reading surface; never consults document IDs. */
export function findPreviewPassage(
  root: HTMLElement,
  target: Pick<PreviewTarget, "heading" | "blockId">,
): HTMLElement | null {
  if (target.blockId) {
    return (
      Array.from(root.querySelectorAll<HTMLElement>("[data-block-id]")).find(
        (element) => element.dataset.blockId === target.blockId,
      ) ?? null
    );
  }
  if (!target.heading) return null;
  const wanted = headingSlug(target.heading);
  const used = new Set<string>();
  for (const heading of root.querySelectorAll<HTMLElement>(
    "h1,h2,h3,h4,h5,h6",
  )) {
    let text = "";
    if (!heading.dataset.headingId) {
      const content = heading.cloneNode(true);
      if (content instanceof HTMLElement) {
        for (const control of content.querySelectorAll(
          "button,[aria-hidden=true],[data-slate-zero-width],[data-slate-spacer]",
        ))
          control.remove();
        text = content.textContent ?? "";
      }
    }
    const id = heading.dataset.headingId ?? nextHeadingId(text, used);
    used.add(id);
    if (id === wanted) return heading;
  }
  return null;
}

interface PassageNode {
  type: string;
  value?: string;
  alt?: string | null;
  children?: PassageNode[];
  data?: {
    alias?: string;
    hProperties?: Record<string, unknown>;
  };
}

function headingText(node: PassageNode): string {
  if (node.type === "wikiLink") return node.data?.alias ?? node.value ?? "";
  return (
    node.value ?? node.alt ?? node.children?.map(headingText).join("") ?? ""
  );
}

/** Marks source blocks and headings without globally addressable IDs. */
export function remarkPreviewPassages(): (tree: Root) => void {
  return (tree) => {
    const used = new Set<string>();
    function visit(node: PassageNode, parent?: PassageNode): void {
      if (["paragraph", "heading", "code"].includes(node.type)) {
        let last = node;
        while (last.children?.length)
          last = last.children[last.children.length - 1];
        // The canonical code serializer puts its marker inside the fence, at
        // the end of the value; mdast-to-slate consumes this same grammar.
        // Inline code remains literal, even when it ends with marker-like text.
        const match = /\s+\^([A-Za-z0-9]{10,12})\s*$/.exec(last.value ?? "");
        if (match && (last.type === "text" || node.type === "code")) {
          const owner = parent?.type === "listItem" ? parent : node;
          owner.data = {
            ...owner.data,
            hProperties: {
              ...owner.data?.hProperties,
              "data-block-id": match[1],
            },
          };
          last.value = last.value?.slice(0, match.index);
        }
      }
      if (node.type === "heading") {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            "data-heading-id": nextHeadingId(headingText(node), used),
          },
        };
      }
      for (const child of node.children ?? []) visit(child, node);
    }
    visit(tree);
  };
}
