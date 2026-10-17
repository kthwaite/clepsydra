import type { Code, RootContent } from "mdast";
import type { Options } from "mdast-util-to-markdown";
import { parse, stringify } from "smol-toml";
import type { SearchEmbedElement } from "#/editor/schema/types";

export interface SearchEmbedConfig {
  query: string;
  limit?: number;
}

export function searchConfigError(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "Search configuration must be a TOML table.";
  }
  const config = value as Record<string, unknown>;
  const unknown = Object.keys(config).find(
    (key) => key !== "query" && key !== "limit",
  );
  if (unknown) return `Unknown search option: ${unknown}.`;
  if (typeof config.query !== "string" || !config.query.trim()) {
    return "Query must be a nonblank string.";
  }
  if (
    config.limit !== undefined &&
    (typeof config.limit !== "number" ||
      !Number.isInteger(config.limit) ||
      config.limit < 1 ||
      config.limit > 200)
  ) {
    return "Limit must be an integer from 1 to 200.";
  }
  return undefined;
}

export function parseSearchConfig(
  source: string,
):
  | { config: SearchEmbedConfig; error?: never }
  | { error: string; config?: never } {
  try {
    const value = parse(source);
    const error = searchConfigError(value);
    if (error) return { error };
    return { config: value as unknown as SearchEmbedConfig };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function searchEmbedFromCode(
  node: Code,
  source: string,
): SearchEmbedElement | undefined {
  if (node.lang !== "search") return undefined;
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  let rawBlock = source.slice(start, end);
  if (end !== undefined) {
    if (source.startsWith("\r\n", end)) rawBlock += "\r\n";
    else if (source[end] === "\n" || source[end] === "\r")
      rawBlock += source[end];
  }
  if ((node.position?.start.column ?? 1) > 1) {
    // mdast positions include container prefixes after the first line.
    // The parsed code value has those prefixes (not its TOML content) removed.
    const ending = rawBlock.match(/\r\n$|\r$|\n$/)?.[0] ?? "";
    const newline = rawBlock.match(/\r\n|\r|\n/)?.[0] ?? "\n";
    const lines = rawBlock
      .slice(0, rawBlock.length - ending.length)
      .split(/\r\n|\r|\n/);
    const opening = lines[0];
    const delimiter = opening.match(/^(`{3,}|~{3,})/)?.[1];
    const candidate = lines
      .at(-1)
      ?.match(/^[\t >]*((?:`{3,}|~{3,})[ \t]*)$/)?.[1];
    const closing =
      delimiter && candidate?.startsWith(delimiter) ? candidate : undefined;
    const body =
      node.value === ""
        ? Array<string>(Math.max(0, lines.length - (closing ? 2 : 1))).fill("")
        : node.value.split(/\r\n|\r|\n/);
    rawBlock =
      [opening, ...body, ...(closing ? [closing] : [])].join(newline) + ending;
  }
  const parsed = parseSearchConfig(node.value);
  const error =
    node.meta != null ? "Unknown search fence metadata." : parsed.error;
  if (error || !parsed.config) {
    return {
      type: "search-embed",
      status: "invalid",
      rawBlock,
      source: node.value,
      parseError: error ?? "Invalid search configuration.",
      children: [{ text: "" }],
    };
  }
  return {
    type: "search-embed",
    status: "configured",
    ...parsed.config,
    rawBlock,
    children: [{ text: "" }],
  };
}

interface SearchFence {
  type: "searchFence";
  rawBlock: string;
}

export function searchEmbedToMdast(node: SearchEmbedElement): RootContent {
  let rawBlock = "```search\n```\n";
  if (
    node.status === "invalid" ||
    (node.status === "configured" && node.rawBlock !== undefined)
  ) {
    rawBlock = node.rawBlock ?? rawBlock;
  } else if (node.status === "configured") {
    const body = stringify({
      query: node.query,
      ...(node.limit === undefined ? {} : { limit: node.limit }),
    });
    const longest = Math.max(
      2,
      ...Array.from(body.matchAll(/`+/g), (match) => match[0].length),
    );
    const fence = "`".repeat(longest + 1);
    rawBlock = `${fence}search\n${body.trimEnd()}\n${fence}\n`;
  }
  return { type: "searchFence", rawBlock } as unknown as RootContent;
}

export function searchFenceToMarkdown(): Options {
  return {
    handlers: {
      searchFence: (node: SearchFence, parent?: { type: string }) =>
        parent?.type === "root"
          ? node.rawBlock
          : node.rawBlock.replace(/(?:\r\n|\r|\n)$/, ""),
    } as Options["handlers"],
    join: [
      (left, _right, parent) => {
        if (parent.type !== "root") return undefined;
        const fence = left as unknown as Partial<SearchFence>;
        if (fence.type !== "searchFence") return undefined;
        return /[\r\n]$/.test(fence.rawBlock ?? "") ? 0 : 1;
      },
    ],
  };
}
