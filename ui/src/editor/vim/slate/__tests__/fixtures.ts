/**
 * Text-based fixtures for vim adapter tests.
 *
 * Markers inside fixture text set the editor selection:
 *   "|"  collapsed cursor        docFrom("one tw|o")
 *   "⟨⟩" range anchor/focus      docFrom("a⟨bc⟩d")
 *
 * `snapshot(editor)` renders the document back to marked strings (one per
 * lowest block, prefixed by block type), so tests read as before/after pairs.
 */
import {
  createEditor,
  type Descendant,
  Editor,
  Element,
  Node,
  Path,
  type Point,
  Transforms,
} from "slate";
import { withHistory } from "slate-history";
import { withAutoformat } from "#/editor/plugins/autoformat/withAutoformat";
import { withOutliner } from "#/editor/plugins/withOutliner";
import type { CustomText, ListItemElement } from "#/editor/schema/types";
import { withSchema } from "#/editor/schema/withSchema";

const CURSOR = "|";
const ANCHOR = "⟨";
const FOCUS = "⟩";

// --- Element constructors (marker chars allowed in text) ---

type Inline = string | CustomText;

const toTexts = (parts: Inline[]): CustomText[] =>
  parts.length === 0
    ? [{ text: "" }]
    : parts.map((part) => (typeof part === "string" ? { text: part } : part));

export const t = (text: string, marks: Omit<CustomText, "text">): CustomText =>
  ({ text, ...marks }) as CustomText;

export const p = (...parts: Inline[]): Descendant => ({
  type: "paragraph",
  children: toTexts(parts),
});

export const code = (text: string): Descendant => ({
  type: "code-block",
  children: [{ text }],
});

export const li = (...content: (Inline | Descendant)[]): ListItemElement => {
  const children: Descendant[] = [];
  const inlines: Inline[] = [];
  for (const item of content) {
    if (typeof item === "string" || !("type" in item)) {
      inlines.push(item as Inline);
    } else {
      children.push(item);
    }
  }
  return {
    type: "list-item",
    children: [p(...inlines), ...children],
  };
};

export const ul = (...items: ListItemElement[]): Descendant => ({
  type: "bulleted-list",
  children: items,
});

export const hr = (): Descendant => ({
  type: "thematic-break",
  children: [{ text: "" }],
});

// --- Editor construction ---

interface FoundMarker {
  path: Path;
  offset: number;
}

function stripMarkers(
  nodes: Descendant[],
  base: Path,
  found: Map<string, FoundMarker>,
): Descendant[] {
  return nodes.map((node, i) => {
    const path = [...base, i];
    if ("text" in node && !("type" in node)) {
      let clean = "";
      for (const ch of node.text) {
        if (ch === CURSOR || ch === ANCHOR || ch === FOCUS) {
          found.set(ch, { path, offset: clean.length });
        } else {
          clean += ch;
        }
      }
      return { ...node, text: clean };
    }
    const element = node as Element;
    return {
      ...element,
      children: stripMarkers(element.children as Descendant[], path, found),
    } as Descendant;
  });
}

/** Production plugin chain minus the React/paste layers. */
export function makeEditor(...blocks: Descendant[]): Editor {
  const found = new Map<string, FoundMarker>();
  const children = stripMarkers(blocks, [], found);
  const editor = withHistory(
    withAutoformat(withOutliner(withSchema(createEditor()))),
  );
  editor.children = children;
  const cursor = found.get(CURSOR);
  const anchor = found.get(ANCHOR);
  const focus = found.get(FOCUS);
  if (anchor && focus) {
    Transforms.select(editor, { anchor, focus });
  } else if (cursor) {
    Transforms.select(editor, { path: cursor.path, offset: cursor.offset });
  }
  return editor;
}

/** Paragraphs-only shorthand: one string per paragraph. */
export function docFrom(...lines: string[]): Editor {
  return makeEditor(...lines.map((line) => p(line)));
}

// --- Snapshots ---

function blockOffset(editor: Editor, blockPath: Path, point: Point): number {
  const start = Editor.start(editor, blockPath);
  return Editor.string(editor, { anchor: start, focus: point }).length;
}

function blockPrefix(editor: Editor, path: Path, node: Element): string {
  if (node.type === "heading") return `h${node.level}:`;
  if (node.type === "code-block") return "code:";
  if (node.type === "thematic-break") return "hr";
  let listDepth = 0;
  let inQuote = false;
  for (let i = 1; i < path.length; i++) {
    const ancestor = Node.get(editor, path.slice(0, i));
    if (Element.isElement(ancestor)) {
      if (ancestor.type === "list-item") listDepth++;
      if (ancestor.type === "blockquote") inQuote = true;
    }
  }
  if (listDepth > 0) return listDepth > 1 ? `li${listDepth}:` : "li:";
  if (inQuote) return "q:";
  return "";
}

/**
 * Render the document as one marked string per lowest block:
 * `["one tw|o", "li:item", "code:a\nb", "hr"]`.
 */
export function snapshot(editor: Editor): string[] {
  const sel = editor.selection;
  const out: string[] = [];
  for (const [node, path] of Editor.nodes(editor, {
    at: [],
    match: (n) => Element.isElement(n) && Editor.isBlock(editor, n),
    mode: "lowest",
  })) {
    const element = node as Element;
    const prefix = blockPrefix(editor, path, element);
    if (element.type === "thematic-break") {
      out.push(prefix);
      continue;
    }
    let text = Node.string(element);
    const inserts: { offset: number; marker: string }[] = [];
    if (sel) {
      const within = (point: Point) =>
        Path.equals(path, point.path) || Path.isAncestor(path, point.path);
      if (
        Path.equals(sel.anchor.path, sel.focus.path) &&
        sel.anchor.offset === sel.focus.offset
      ) {
        if (within(sel.anchor)) {
          inserts.push({
            offset: blockOffset(editor, path, sel.anchor),
            marker: CURSOR,
          });
        }
      } else {
        if (within(sel.anchor)) {
          inserts.push({
            offset: blockOffset(editor, path, sel.anchor),
            marker: ANCHOR,
          });
        }
        if (within(sel.focus)) {
          inserts.push({
            offset: blockOffset(editor, path, sel.focus),
            marker: FOCUS,
          });
        }
      }
    }
    inserts.sort((a, b) => b.offset - a.offset);
    for (const { offset, marker } of inserts) {
      text = text.slice(0, offset) + marker + text.slice(offset);
    }
    out.push(prefix + text);
  }
  return out;
}
