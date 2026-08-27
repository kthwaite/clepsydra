import type { Element, ElementContent } from "hast";

/** Info string that marks a fenced code block as a mermaid diagram. */
export const MERMAID_LANGUAGE = "mermaid";

function classNames(node: Element): string[] {
  const className = node.properties?.className;
  if (Array.isArray(className)) return className.map(String);
  if (typeof className === "string") return className.split(/\s+/);
  return [];
}

/** The info string of a rendered fence (`language-rust` → `rust`), if any. */
function fenceLanguage(node: Element): string | null {
  for (const name of classNames(node)) {
    if (name.startsWith("language-")) {
      return name.slice("language-".length).toLowerCase();
    }
  }
  return null;
}

function textOf(children: ElementContent[]): string {
  let text = "";
  for (const child of children) {
    if (child.type === "text") text += child.value;
    else if (child.type === "element") text += textOf(child.children);
  }
  return text;
}

/**
 * The mermaid source of a rendered `<pre>` fence, or null when the node is not
 * a ```mermaid block. react-markdown hands `pre` overrides the hast node, so
 * the language survives even though the JSX children are already React
 * elements.
 */
export function mermaidFenceSource(node: Element | undefined): string | null {
  if (node?.tagName !== "pre") return null;
  const code = node.children.find(
    (child): child is Element =>
      child.type === "element" && child.tagName === "code",
  );
  if (!code || fenceLanguage(code) !== MERMAID_LANGUAGE) return null;
  // Fenced code always carries a trailing newline from the parser.
  return textOf(code.children).replace(/\n$/, "");
}
