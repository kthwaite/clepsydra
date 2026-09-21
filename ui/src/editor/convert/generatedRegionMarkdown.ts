import type { RootContent } from "mdast";
import type { Options } from "mdast-util-to-markdown";
import { parse } from "smol-toml";
import type {
  GeneratedRegionDescriptor,
  GeneratedRegionElement,
} from "#/editor/schema/types";
import { validateBaseEmbedShape } from "./baseEmbedMarkdown";

interface Directive {
  index: number;
  start: number;
  commentStart: number;
  end: number;
  rawEnd: number;
  kind: "start" | "end";
  value: string;
  remainder?: string;
}

interface RecoveredMarkdown {
  type: "recovered-markdown";
  source: string;
}

type GeneratedRegionBlock =
  | RootContent
  | GeneratedRegionElement
  | RecoveredMarkdown;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^blake3:[0-9a-f]{64}$/;
const DESCRIPTOR_KEYS: Record<string, true> = {
  version: true,
  id: true,
  base: true,
  view: true,
  template: true,
  filter: true,
  sort: true,
  limit: true,
  output_hash: true,
};

function parseDescriptor(header: string): GeneratedRegionDescriptor {
  const match = /^<!-- clep:generated\r?\n([\s\S]*)-->$/.exec(header);
  if (!match) throw new Error("Malformed generated-region header");
  const descriptor = parse(match[1]);
  if (
    Object.keys(descriptor).some((key) => !Object.hasOwn(DESCRIPTOR_KEYS, key))
  ) {
    throw new Error("Unknown generated-region descriptor field");
  }
  if (descriptor.version !== 1)
    throw new Error("Unsupported generated-region version");
  if (typeof descriptor.id !== "string" || !UUID.test(descriptor.id)) {
    throw new Error("Invalid generated-region ID");
  }
  if (
    typeof descriptor.output_hash !== "string" ||
    !HASH.test(descriptor.output_hash)
  ) {
    throw new Error("Invalid generated-region output hash");
  }
  if (
    typeof descriptor.template !== "string" ||
    descriptor.template.trim() === ""
  ) {
    throw new Error("Missing generated-region template");
  }
  const {
    version: _version,
    id: _id,
    output_hash: _hash,
    template: _template,
    limit,
    ...selection
  } = descriptor;
  const diagnostics = validateBaseEmbedShape({
    ...selection,
    view: selection.view ?? "Generated",
  });
  if (diagnostics.length > 0) throw new Error(diagnostics[0].message);
  if (
    limit !== undefined &&
    (typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000)
  ) {
    throw new Error("Invalid generated-region limit");
  }
  return descriptor as unknown as GeneratedRegionDescriptor;
}

function directive(
  node: RootContent,
  index: number,
  source: string,
): Directive | undefined {
  if (node.type !== "html") return undefined;
  const start = node.position?.start.offset;
  let rawEnd = node.position?.end.offset;
  if (start === undefined || rawEnd === undefined) return undefined;
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const indentation = /^ {0,3}(?=<!--)/.exec(source.slice(start, rawEnd));
  const commentStart = start + (indentation?.[0].length ?? 0);
  if (!/^ {0,3}$/.test(source.slice(lineStart, commentStart))) return undefined;
  let value = source.slice(commentStart, rawEnd);
  const closing = value.indexOf("-->");
  let remainder: string | undefined;
  let end = rawEnd;
  if (closing >= 0) {
    // A directive comment must stand alone on its Markdown line.
    if (value.slice(closing + 3).trim() !== "") return undefined;
    end = commentStart + closing + 3;
    value = value.slice(0, closing + 3);
  } else {
    // An unterminated HTML comment owns the remaining document in CommonMark.
    // A blank line is the conservative repair boundary, not part of the header.
    const boundary = /\r?\n[ \t]*\r?\n/.exec(value);
    if (boundary) {
      remainder = value.slice(boundary.index);
      end = commentStart + boundary.index;
      rawEnd = end;
      value = value.slice(0, boundary.index);
    }
  }
  if (source.startsWith("\r\n", rawEnd)) rawEnd += 2;
  else if (source[rawEnd] === "\n") rawEnd++;
  const marker = {
    index,
    start: lineStart,
    commentStart,
    end,
    rawEnd,
    value,
    remainder,
  };
  if (/^<!-- clep:generated(?:\s|-->)/.test(value)) {
    return { ...marker, kind: "start" };
  }
  if (/^<!-- \/clep:generated(?:\s|-->)/.test(value)) {
    return { ...marker, kind: "end" };
  }
  return undefined;
}

function invalidRegion(
  rawBlock: string,
  parseError: string,
): GeneratedRegionElement {
  return {
    type: "generated-region",
    status: "invalid",
    rawBlock,
    parseError,
    children: [{ text: "" }],
  };
}

/** Only root-level Markdown HTML nodes can establish region boundaries. */
export function generatedRegionBlocks(
  nodes: RootContent[],
  source: string,
): GeneratedRegionBlock[] {
  const directives = nodes.flatMap((node, index) => {
    const marker = directive(node, index, source);
    return marker ? [marker] : [];
  });
  const replacements = new Map<
    number,
    {
      endIndex: number;
      element: GeneratedRegionElement;
      remainder?: string;
    }
  >();
  for (const marker of directives) {
    replacements.set(marker.index, {
      endIndex: marker.index,
      remainder: marker.remainder,
      element: invalidRegion(
        source.slice(marker.start, marker.rawEnd),
        marker.kind === "start"
          ? "Missing or malformed generated-region end marker"
          : "Unmatched or malformed generated-region end marker",
      ),
    });
  }
  let opening: Directive | undefined;
  let depth = 0;
  let nested = false;
  for (const marker of directives) {
    if (marker.kind === "start") {
      if (opening) {
        nested = true;
      } else {
        opening = marker;
        nested = false;
      }
      depth++;
      continue;
    }
    if (!opening || --depth > 0) continue;
    const start = opening;
    const end = marker;
    opening = undefined;
    if (end.value !== "<!-- /clep:generated -->") continue;
    const rawBlock = source.slice(start.start, end.rawEnd);
    let element: GeneratedRegionElement;
    try {
      if (nested) throw new Error("Nested generated regions are not supported");
      element = {
        type: "generated-region",
        status: "valid",
        rawBlock,
        descriptor: parseDescriptor(start.value),
        payload: source.slice(start.end, end.commentStart),
        children: [{ text: "" }],
      };
    } catch (error) {
      element = invalidRegion(
        rawBlock,
        error instanceof Error ? error.message : String(error),
      );
    }
    replacements.set(start.index, { endIndex: end.index, element });
  }
  const identified = new Map<string, { element: GeneratedRegionElement }>();
  for (const replacement of replacements.values()) {
    if (replacement.element.status !== "valid") continue;
    const id = replacement.element.descriptor.id.toLowerCase();
    const previous = identified.get(id);
    if (previous) {
      previous.element = invalidRegion(
        previous.element.rawBlock,
        "Duplicate generated-region ID",
      );
      replacement.element = invalidRegion(
        replacement.element.rawBlock,
        "Duplicate generated-region ID",
      );
    } else {
      identified.set(id, replacement);
    }
  }
  const result: GeneratedRegionBlock[] = [];
  for (let index = 0; index < nodes.length; index++) {
    const replacement = replacements.get(index);
    if (replacement) {
      result.push(replacement.element);
      index = replacement.endIndex;
      if (replacement.remainder) {
        result.push({
          type: "recovered-markdown",
          source: replacement.remainder,
        });
      }
    } else {
      result.push(nodes[index]);
    }
  }
  return result;
}

export function generatedRegionToMarkdown(): Options {
  return {
    handlers: {
      generatedRegion: (node: { rawBlock: string }) => node.rawBlock,
    } as Options["handlers"],
    join: [
      (left) => {
        const region = left as unknown as { type: string; rawBlock: string };
        if (region.type !== "generatedRegion") return undefined;
        return /[\r\n]$/.test(region.rawBlock) ? 0 : 1;
      },
    ],
  };
}
