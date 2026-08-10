import type { Code, Parents, RootContent } from "mdast";
import type { Info, Options, State } from "mdast-util-to-markdown";
import { parse } from "smol-toml";
import type { BaseFilter, SortKey } from "#/api/bases";
import type { BaseEmbedConfig } from "#/components/bases/embed-query";
import type {
  BaseEmbedElement,
  ConfiguredBaseEmbedElement,
} from "#/editor/schema/types";
import type { BaseFenceMdast } from "./mdastTypes";

export const BASE_EMBED_RECOVERY_BLOCK = "```base\n```\n";
export const BASE_EMBED_RECOVERY_ERROR = "Invalid persisted base-embed node";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_FILTER_DEPTH = 8;
const MAX_FILTER_NODES = 64;
const MAX_LOGICAL_CHILDREN = 32;
const MAX_IN_VALUES = 100;
const MAX_SORT_KEYS = 8;
const MAX_FIELD_BYTES = 256;
const MAX_SCALAR_STRING_BYTES = 4 * 1024;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;
const textEncoder = new TextEncoder();
const VALUELESS_OPERATORS: Record<string, true> = {
  is_empty: true,
  not_empty: true,
};
const FILTER_OPERATORS: Record<string, true> = {
  eq: true,
  ne: true,
  lt: true,
  lte: true,
  gt: true,
  gte: true,
  contains: true,
  in: true,
  links_to: true,
  is_empty: true,
  not_empty: true,
};

class BaseEmbedValidationError extends Error {}

function fail(message: string): never {
  throw new BaseEmbedValidationError(message);
}

function isTable(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertClosedKeys(
  table: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(table)) {
    if (!allowed.has(key)) fail(`Unknown key \`${key}\``);
  }
  for (const key of required) {
    if (!Object.hasOwn(table, key)) fail(`Missing required key \`${key}\``);
  }
}

function assertBoundedField(value: unknown): asserts value is string {
  if (typeof value !== "string") fail("Filter and sort fields must be strings");
  const bytes = textEncoder.encode(value).length;
  if (bytes > MAX_FIELD_BYTES) {
    fail(`Field identifier is ${bytes} UTF-8 bytes; maximum is ${MAX_FIELD_BYTES}`);
  }
}

function validateTomlData(value: unknown): void {
  const stack = [value];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") {
      const bytes = textEncoder.encode(current).length;
      if (bytes > MAX_SCALAR_STRING_BYTES) {
        fail(
          `String value is ${bytes} UTF-8 bytes; maximum is ${MAX_SCALAR_STRING_BYTES}`,
        );
      }
      continue;
    }
    if (
      typeof current === "boolean" ||
      (typeof current === "number" && Number.isFinite(current))
    ) {
      continue;
    }
    if (Array.isArray(current)) {
      if (seen.has(current)) fail("Cyclic values cannot be persisted");
      seen.add(current);
      stack.push(...current);
      continue;
    }
    if (isTable(current)) {
      if (seen.has(current)) fail("Cyclic values cannot be persisted");
      seen.add(current);
      stack.push(...Object.values(current));
      continue;
    }
    fail("Filter values must be JSON-compatible TOML data");
  }
}

interface FilterValidationState {
  nodes: number;
}

function validateFilter(
  value: unknown,
  depth: number,
  state: FilterValidationState,
): asserts value is BaseFilter {
  if (!isTable(value)) fail("Filter nodes must be inline tables");
  state.nodes += 1;
  if (depth > MAX_FILTER_DEPTH) {
    fail(`Filter depth ${depth} exceeds maximum of ${MAX_FILTER_DEPTH}`);
  }
  if (state.nodes > MAX_FILTER_NODES) {
    fail(`Filter has more than ${MAX_FILTER_NODES} nodes`);
  }

  if (Object.hasOwn(value, "all") || Object.hasOwn(value, "any")) {
    const key = Object.hasOwn(value, "all") ? "all" : "any";
    assertClosedKeys(value, [key]);
    const children = value[key];
    if (!Array.isArray(children)) fail(`Filter \`${key}\` must be an array`);
    if (children.length > MAX_LOGICAL_CHILDREN) {
      fail(
        `Filter group has ${children.length} children; maximum is ${MAX_LOGICAL_CHILDREN}`,
      );
    }
    for (const child of children) validateFilter(child, depth + 1, state);
    return;
  }

  if (Object.hasOwn(value, "not")) {
    assertClosedKeys(value, ["not"]);
    validateFilter(value.not, depth + 1, state);
    return;
  }

  if (
    typeof value.op !== "string" ||
    !Object.hasOwn(FILTER_OPERATORS, value.op)
  ) {
    fail("Filter comparison has an unknown operator");
  }
  const carriesValue = !Object.hasOwn(VALUELESS_OPERATORS, value.op);
  assertClosedKeys(value, carriesValue ? ["field", "op", "value"] : ["field", "op"]);
  assertBoundedField(value.field);
  if (!carriesValue) return;
  if (value.op === "links_to" && typeof value.value !== "string") {
    fail("Filter operator `links_to` expects a string target");
  }
  if (value.op === "in") {
    if (!Array.isArray(value.value)) fail("Filter operator `in` expects an array");
    if (value.value.length > MAX_IN_VALUES) {
      fail(`Filter operator \`in\` accepts at most ${MAX_IN_VALUES} values`);
    }
  }
  validateTomlData(value.value);
}

function validateSort(value: unknown): asserts value is SortKey[] {
  if (!Array.isArray(value)) fail("Sort must be an array");
  if (value.length > MAX_SORT_KEYS) {
    fail(`Sort has ${value.length} keys; maximum is ${MAX_SORT_KEYS}`);
  }
  for (const item of value) {
    if (!isTable(item)) fail("Sort keys must be inline tables");
    assertClosedKeys(item, ["field"], ["dir"]);
    assertBoundedField(item.field);
    if (
      Object.hasOwn(item, "dir") &&
      item.dir !== "asc" &&
      item.dir !== "desc"
    ) {
      fail("Sort direction must be `asc` or `desc`");
    }
  }
}

function validateBaseEmbedConfig(value: unknown): asserts value is BaseEmbedConfig {
  if (!isTable(value)) fail("Base embed configuration must be a TOML table");
  assertClosedKeys(value, ["base", "view"], ["filter", "sort", "limit"]);
  if (typeof value.base !== "string" || value.base.trim().length === 0) {
    fail("`base` must be a nonblank string");
  }
  if (typeof value.view !== "string" || value.view.trim().length === 0) {
    fail("`view` must be a nonblank string");
  }
  if (Object.hasOwn(value, "filter")) {
    validateFilter(value.filter, 1, { nodes: 0 });
  }
  if (Object.hasOwn(value, "sort")) validateSort(value.sort);
  if (
    Object.hasOwn(value, "limit") &&
    (!Number.isInteger(value.limit) ||
      (value.limit as number) < MIN_LIMIT ||
      (value.limit as number) > MAX_LIMIT)
  ) {
    fail(`\`limit\` must be an integer from ${MIN_LIMIT} through ${MAX_LIMIT}`);
  }
}

function quotedTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function serializeTomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeTomlValue).join(", ")}]`;
  }
  if (isTable(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${quotedTomlKey(key)} = ${serializeTomlValue(value[key])}`);
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
  }
  return fail("Unsupported TOML value");
}

function serializeFilter(filter: BaseFilter): string {
  if ("all" in filter) {
    return `{ all = [${filter.all.map(serializeFilter).join(", ")}] }`;
  }
  if ("any" in filter) {
    return `{ any = [${filter.any.map(serializeFilter).join(", ")}] }`;
  }
  if ("not" in filter) return `{ not = ${serializeFilter(filter.not)} }`;

  const fields = [
    `field = ${JSON.stringify(filter.field)}`,
    `op = ${JSON.stringify(filter.op)}`,
  ];
  if (!Object.hasOwn(VALUELESS_OPERATORS, filter.op)) {
    fields.push(`value = ${serializeTomlValue(filter.value)}`);
  }
  return `{ ${fields.join(", ")} }`;
}

function serializeSort(sort: SortKey[]): string {
  return `[${sort
    .map((key) => {
      const fields = [`field = ${JSON.stringify(key.field)}`];
      if (key.dir !== undefined) fields.push(`dir = ${JSON.stringify(key.dir)}`);
      return `{ ${fields.join(", ")} }`;
    })
    .join(", ")}]`;
}

function canonicalBody(config: BaseEmbedConfig): string {
  validateBaseEmbedConfig(config);
  const lines = [
    `base = ${JSON.stringify(config.base)}`,
    `view = ${JSON.stringify(config.view)}`,
  ];
  if (config.filter !== undefined) {
    lines.push(`filter = ${serializeFilter(config.filter)}`);
  }
  if (config.sort !== undefined) lines.push(`sort = ${serializeSort(config.sort)}`);
  if (config.limit !== undefined) lines.push(`limit = ${config.limit}`);
  const body = `${lines.join("\n")}\n`;
  if (textEncoder.encode(body).length > MAX_BODY_BYTES) {
    fail(`Base embed TOML body exceeds ${MAX_BODY_BYTES} UTF-8 bytes`);
  }
  return body;
}

export function isCanonicalBaseEmbedConfig(
  value: unknown,
): value is BaseEmbedConfig {
  try {
    canonicalBody(value as BaseEmbedConfig);
    return true;
  } catch {
    return false;
  }
}

interface FenceSource {
  rawBlock: string;
  body: string;
}

function sliceFenceSource(node: Code, source: string): FenceSource {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) {
    fail("Base fence has no source offsets");
  }

  const positionedBlock = source.slice(start, end);
  let rawBlock = positionedBlock;
  if (source.startsWith("\r\n", end)) rawBlock += "\r\n";
  else if (source[end] === "\n" || source[end] === "\r") rawBlock += source[end];

  const openingEnd = positionedBlock.indexOf("\n");
  if (openingEnd === -1) return { rawBlock, body: "" };
  const openingLine = positionedBlock
    .slice(0, openingEnd)
    .replace(/\r$/, "");
  const opening = openingLine.match(/^ {0,3}(`{3,}|~{3,})base[ \t]*$/);
  if (!opening) fail("Invalid Base fence opening delimiter");

  const delimiter = opening[1];
  const lastLineStart = positionedBlock.lastIndexOf("\n") + 1;
  const lastLine = positionedBlock.slice(lastLineStart).replace(/\r$/, "");
  const closing = new RegExp(
    `^ {0,3}\\${delimiter[0]}{${delimiter.length},}[ \\t]*$`,
  );
  const bodyStart = openingEnd + 1;
  return {
    rawBlock,
    body: closing.test(lastLine)
      ? positionedBlock.slice(bodyStart, lastLineStart)
      : positionedBlock.slice(bodyStart),
  };
}

export function baseEmbedFromCode(
  node: Code,
  source: string,
): BaseEmbedElement | undefined {
  if (node.lang !== "base" || node.meta != null) return undefined;

  let rawBlock = BASE_EMBED_RECOVERY_BLOCK;
  try {
    const sourceFence = sliceFenceSource(node, source);
    rawBlock = sourceFence.rawBlock;
    const bodyBytes = textEncoder.encode(sourceFence.body).length;
    if (bodyBytes > MAX_BODY_BYTES) {
      fail(`Base embed TOML body is ${bodyBytes} UTF-8 bytes; maximum is ${MAX_BODY_BYTES}`);
    }
    const config = parse(sourceFence.body) as unknown;
    validateBaseEmbedConfig(config);
    return {
      type: "base-embed",
      status: "configured",
      ...config,
      children: [{ text: "" }],
    };
  } catch (error) {
    return {
      type: "base-embed",
      status: "invalid",
      rawBlock,
      parseError: error instanceof Error ? error.message : String(error),
      children: [{ text: "" }],
    };
  }
}

function configuredRawBlock(node: ConfiguredBaseEmbedElement): string {
  const { base, view, filter, sort, limit } = node;
  return `\`\`\`base\n${canonicalBody({
    base,
    view,
    ...(filter === undefined ? {} : { filter }),
    ...(sort === undefined ? {} : { sort }),
    ...(limit === undefined ? {} : { limit }),
  })}\`\`\`\n`;
}

export function baseEmbedToMdast(node: BaseEmbedElement): RootContent {
  let rawBlock = BASE_EMBED_RECOVERY_BLOCK;
  if (node.status === "invalid") rawBlock = node.rawBlock;
  else if (node.status === "configured") {
    try {
      rawBlock = configuredRawBlock(node);
    } catch {
      rawBlock = BASE_EMBED_RECOVERY_BLOCK;
    }
  }
  return { type: "baseFence", rawBlock } as BaseFenceMdast as unknown as RootContent;
}

function baseFenceHandler(
  node: BaseFenceMdast,
  _parent: Parents | undefined,
  _state: State,
  _info: Info,
): string {
  return node.rawBlock;
}

export function baseFenceToMarkdown(): Options {
  return {
    handlers: { baseFence: baseFenceHandler } as Options["handlers"],
    join: [
      (left) => {
        const baseFence = left as unknown as Partial<BaseFenceMdast>;
        if (baseFence.type !== "baseFence") return undefined;
        return /[\r\n]$/.test(baseFence.rawBlock ?? "") ? 0 : 1;
      },
    ],
  };
}
