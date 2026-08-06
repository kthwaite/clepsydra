import { type NodeEntry, type Range, Element as SlateElement } from "slate";
import { loadRefractor, type Refractor } from "#/editor/refractor-lazy";

/** Prism token type → Vessel colour CSS var, applied by renderLeaf. */
export const TOKEN_COLOR: Record<string, string> = {
  keyword: "var(--cool)",
  string: "var(--warn)",
  comment: "var(--ink-mute)",
  function: "var(--accent)",
  "class-name": "var(--accent)",
  number: "var(--accent-deep)",
  boolean: "var(--accent-deep)",
  constant: "var(--accent-deep)",
  operator: "var(--ink-2)",
  punctuation: "var(--ink-mute)",
  property: "var(--cool)",
  tag: "var(--cool)",
  "attr-name": "var(--accent-deep)",
  "attr-value": "var(--warn)",
  regex: "var(--warn)",
  builtin: "var(--accent)",
};

// Minimal hast shapes we read (avoid pulling @types/hast).
type HastNode =
  | { type: "text"; value: string }
  | {
      type: "element";
      properties?: { className?: string[] };
      children: HastNode[];
    }
  | { type: "root"; children: HastNode[] };

/**
 * Build a Slate `decorate` for code blocks: tokenize the block's text with
 * refractor and return ranges (anchored to child text 0) carrying a `token`
 * type. The grammar bundle is injected (see refractor-lazy.ts); while it is
 * still loading (`highlighter` null) blocks render plain, the load is kicked
 * off, and the caller re-decorates once it lands.
 */
export function makeDecorateCode(highlighter: Refractor | null) {
  return ([node, path]: NodeEntry): Range[] => {
    if (!SlateElement.isElement(node) || node.type !== "code-block") return [];
    const lang = node.language;
    if (!lang) return [];

    if (!highlighter) {
      void loadRefractor();
      return [];
    }

    const text = node.children.map((c) => ("text" in c ? c.text : "")).join("");

    let root: HastNode;
    try {
      root = highlighter.highlight(text, lang) as unknown as HastNode;
    } catch {
      return []; // unknown/unregistered language → plain (no highlighting)
    }

    const ranges: Range[] = [];
    let offset = 0;
    const textPath = [...path, 0];

    const visit = (n: HastNode, types: string[]) => {
      if (n.type === "text") {
        const len = n.value.length;
        if (len > 0 && types.length > 0) {
          ranges.push({
            anchor: { path: textPath, offset },
            focus: { path: textPath, offset: offset + len },
            token: types[types.length - 1],
          });
        }
        offset += len;
        return;
      }
      if (n.type === "element") {
        const classes = n.properties?.className ?? [];
        const tokenTypes = classes.filter((c) => c !== "token");
        const next = tokenTypes.length ? [...types, ...tokenTypes] : types;
        for (const child of n.children) visit(child, next);
        return;
      }
      if (n.type === "root") {
        for (const child of n.children) visit(child, types);
      }
    };

    visit(root, []);
    return ranges;
  };
}
