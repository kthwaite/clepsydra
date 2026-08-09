import type { Data as MdastData, Parents, Root } from "mdast";
import type { InlineMath, Math } from "mdast-util-math";
import { mathFromMarkdown } from "mdast-util-math";
import type {
  Info,
  Options,
  State,
} from "mdast-util-to-markdown";
import { math as mathSyntax } from "micromark-extension-math-extended";
import type { Data as ProcessorData, Plugin } from "unified";

export type MathDelimiter = "$" | "$$" | "\\(" | "\\[";

export interface FolioMathData extends MdastData {
  folioDelimiter: MathDelimiter;
  folioSourceBody: string;
  hName?: "span" | "div";
  hChildren?: [];
  hProperties?: {
    "data-folio-math": true;
    "data-tex": string;
    "data-delimiter": MathDelimiter;
  };
}

type FolioMathNode = (
  | Omit<InlineMath, "data">
  | Omit<Math, "data">
) & { data?: MdastData };
type MutableParent = { children: MutableNode[] };
type MutableNode =
  | FolioMathNode
  | {
      type: string;
      children?: MutableNode[];
      position?: FolioMathNode["position"];
      value?: string;
    };

const closingDelimiter: Record<MathDelimiter, string> = {
  $: "$",
  $$: "$$",
  "\\(": "\\)",
  "\\[": "\\]",
};

export function formatMathSource(
  tex: string,
  delimiter: MathDelimiter,
): string {
  return delimiter + tex + closingDelimiter[delimiter];
}

function delimiterFor(
  node: InlineMath | Math,
  kind: "inline" | "display",
): MathDelimiter {
  const delimiter = (node.data as FolioMathData | undefined)?.folioDelimiter;

  if (kind === "inline") {
    return delimiter === "\\(" || delimiter === "$" ? delimiter : "$";
  }

  return delimiter === "\\[" || delimiter === "$$" ? delimiter : "$$";
}

function sourceBody(node: InlineMath | Math): string {
  const body = (node.data as FolioMathData | undefined)?.folioSourceBody;
  return typeof body === "string" ? body : node.value || "";
}

function delimiterFromSource(
  node: FolioMathNode,
  source: string,
): MathDelimiter | undefined {
  if (node.type === "inlineMath") {
    if (source.startsWith("$$")) return "$$";
    if (source.startsWith("$")) return "$";
    if (source.startsWith("\\(")) return "\\(";
    return undefined;
  }

  if (source.startsWith("$$") && !source.startsWith("$$$")) return "$$";
  if (source.startsWith("\\[")) return "\\[";
  return undefined;
}

function restoreSource(node: FolioMathNode, source: string): MutableNode {
  const text = { type: "text", value: source, position: node.position };
  return node.type === "inlineMath"
    ? text
    : { type: "paragraph", children: [text], position: node.position };
}

function annotateNode(
  node: FolioMathNode,
  source: string,
): MutableNode | void {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return;

  const construct = source.slice(start, end);
  const delimiter = delimiterFromSource(node, construct);
  if (!delimiter) return restoreSource(node, construct);

  if (node.type === "inlineMath" && delimiter === "$$") {
    return restoreSource(node, construct);
  }

  const close = closingDelimiter[delimiter];
  if (
    construct.length < delimiter.length + close.length ||
    !construct.endsWith(close)
  ) {
    return restoreSource(node, construct);
  }

  const body = construct.slice(delimiter.length, -close.length);
  node.value = body;
  const data: FolioMathData = {
    ...(node.data || {}),
    folioDelimiter: delimiter,
    folioSourceBody: body,
    hName: node.type === "inlineMath" ? "span" : "div",
    hChildren: [],
    hProperties: {
      "data-folio-math": true,
      "data-tex": body,
      "data-delimiter": delimiter,
    },
  };
  node.data = data;
}

function annotateMathSource(tree: Root, source: string): void {
  function visit(parent: MutableParent): void {
    for (let index = 0; index < parent.children.length; index++) {
      const child = parent.children[index];

      if (child.type === "math" || child.type === "inlineMath") {
        const replacement = annotateNode(child as FolioMathNode, source);
        if (replacement) parent.children[index] = replacement;
      } else if ("children" in child && child.children) {
        visit(child as MutableParent);
      }
    }
  }

  visit(tree as unknown as MutableParent);
}

export const remarkFolioMath: Plugin<[], Root> = function () {
  const data = this.data() as ProcessorData & {
    toMarkdownExtensions?: Options[];
  };
  (data.micromarkExtensions ??= []).push(
    mathSyntax({ backslashDelimiters: true, singleDollarTextMath: true }),
  );
  (data.fromMarkdownExtensions ??= []).push(mathFromMarkdown());
  (data.toMarkdownExtensions ??= []).push(folioMathToMarkdown());

  return (tree, file) => annotateMathSource(tree, String(file.value));
};

function longestDollarStreak(value: string): number {
  let longest = 0;
  let current = 0;

  for (const character of value) {
    if (character === "$") {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }

  return longest;
}

function serializeDollarInline(node: InlineMath, state: State): string {
  let value = sourceBody(node);
  let size = 1;

  while (new RegExp(`(^|[^$])${"\\$".repeat(size)}([^$]|$)`).test(value)) {
    size++;
  }

  const sequence = "$".repeat(size);

  if (
    /[^ \r\n]/.test(value) &&
    ((/^[ \r\n]/.test(value) && /[ \r\n]$/.test(value)) ||
      /^\$|\$$/.test(value))
  ) {
    value = ` ${value} `;
  }

  let index = -1;
  while (++index < state.unsafe.length) {
    const pattern = state.unsafe[index];
    if (!pattern.atBreak) continue;

    const expression = state.compilePattern(pattern);
    let match: RegExpExecArray | null;

    while ((match = expression.exec(value))) {
      let position = match.index;
      if (
        value.codePointAt(position) === 10 &&
        value.codePointAt(position - 1) === 13
      ) {
        position--;
      }
      value = value.slice(0, position) + " " + value.slice(match.index + 1);
    }
  }

  return sequence + value + sequence;
}

function inlineMath(
  node: InlineMath,
  _parent: Parents | undefined,
  state: State,
): string {
  const delimiter = delimiterFor(node, "inline");
  return delimiter === "\\("
    ? formatMathSource(sourceBody(node), delimiter)
    : serializeDollarInline(node, state);
}

inlineMath.peek = (node: InlineMath): string =>
  delimiterFor(node, "inline") === "\\(" ? "\\" : "$";

function serializeDollarDisplay(
  node: Math,
  state: State,
  info: Info,
): string {
  const raw = sourceBody(node);
  const tracker = state.createTracker(info);
  const sequence = "$".repeat(Math.max(longestDollarStreak(raw) + 1, 2));
  const exit = state.enter("mathFlow");
  let value = tracker.move(sequence);
  // Parsed dollar-display bodies include a line ending between their fences.
  // Bare Slate-created TeX needs the canonical multiline flow layout instead.
  const sourceData = node.data as FolioMathData | undefined;
  const authoredBody =
    typeof sourceData?.folioSourceBody === "string" &&
    (raw.includes("\n") || raw.includes("\r"));

  if (authoredBody) {
    value += tracker.move(raw);
  } else {
    if (node.meta) {
      const subexit = state.enter("mathFlowMeta");
      value += tracker.move(
        state.safe(node.meta, {
          after: "\n",
          before: value,
          encode: ["$"],
          ...tracker.current(),
        }),
      );
      subexit();
    }

    value += tracker.move("\n");
    if (raw) value += tracker.move(`${raw}\n`);
  }

  value += tracker.move(sequence);
  exit();
  return value;
}

function math(
  node: Math,
  _parent: Parents | undefined,
  state: State,
  info: Info,
): string {
  const delimiter = delimiterFor(node, "display");
  return delimiter === "\\["
    ? formatMathSource(sourceBody(node), delimiter)
    : serializeDollarDisplay(node, state, info);
}

export function folioMathToMarkdown(): Options {
  return {
    unsafe: [
      { character: "\r", inConstruct: "mathFlowMeta" },
      { character: "\n", inConstruct: "mathFlowMeta" },
      { character: "$", inConstruct: "phrasing" },
      { character: "$", inConstruct: "mathFlowMeta" },
      { atBreak: true, character: "$", after: "\\$" },
    ],
    handlers: { math, inlineMath } as Options["handlers"],
  };
}

