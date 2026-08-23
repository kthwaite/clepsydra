import { dedent } from "#/recipe/recipeText";

export type RecipeGroup = { name: string | null; items: string[] };

/** `ingredientGroups[0]` and `stepGroups[0]` are always the unnamed lead group;
 * every group after it is named. A recipe with no components is a single lead
 * group. */
export type RecipeDocument = {
  description: string;
  ingredientGroups: RecipeGroup[];
  stepGroups: RecipeGroup[];
  notesMarkdown: string;
};

export type RecipeParseFailure =
  | "missing-section"
  | "duplicate-section"
  | "section-order"
  | "mixed-format"
  | "invalid-ingredient"
  | "invalid-step"
  | "unsupported-content";

export type RecipeParseResult =
  | { ok: true; value: RecipeDocument; sourceFormat: "example" | "markdown" }
  | { ok: false; reason: RecipeParseFailure };

const trimBoundaryBlankLines = (lines: string[]): string[] => {
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start]?.trim() === "") start += 1;
  while (end > start && lines[end - 1]?.trim() === "") end -= 1;

  return lines.slice(start, end);
};

const normalizeLineEndings = (value: string): string =>
  value.replace(/\r\n?/g, "\n");

const joinMarkdown = (lines: string[]): string =>
  trimBoundaryBlankLines(lines).join("\n");

const sectionNames = ["ingredients", "steps", "notes"] as const;

type SectionName = (typeof sectionNames)[number];
type SourceFormat = "example" | "markdown";
/** `depth` is the heading level. The demonstrated marker format has no heading,
 * so it takes depth `0` and both formats compare the same way. */
type SectionMarker = {
  name: SectionName;
  format: SourceFormat;
  depth: number;
  index: number;
};

const parseSectionMarker = (
  line: string,
  index: number,
): SectionMarker | null => {
  const exampleMatch = line.match(/^(ingredients|steps|notes)$/i);
  if (exampleMatch?.[1]) {
    return {
      name: exampleMatch[1].toLowerCase() as SectionName,
      format: "example",
      depth: 0,
      index,
    };
  }

  const markdownMatch = line.match(
    /^(#{1,6})\s+(ingredients|steps|notes)\s*$/i,
  );
  if (!markdownMatch?.[1] || !markdownMatch[2]) return null;

  return {
    name: markdownMatch[2].toLowerCase() as SectionName,
    format: "markdown",
    depth: markdownMatch[1].length,
    index,
  };
};

type ListParseResult =
  | { ok: true; values: string[] }
  | {
      ok: false;
      reason: "invalid-ingredient" | "invalid-step" | "unsupported-content";
    };

/** Shared verdict across ingredient and step parsing: an item-shaped-but-rejected
 * line (a checked task box, a continuation line with nowhere to land) always beats
 * plain unrecognised content, and *both* lose to having zero valid values at all. */
const finishList = (
  values: string[],
  invalidReason: "invalid-ingredient" | "invalid-step",
  hasInvalidItem: boolean,
  hasUnsupportedStructure: boolean,
  hasUnrecognizedContent: boolean,
): ListParseResult => {
  if (hasInvalidItem || (values.length === 0 && hasUnrecognizedContent)) {
    return { ok: false, reason: invalidReason };
  }
  if (hasUnsupportedStructure || hasUnrecognizedContent) {
    return { ok: false, reason: "unsupported-content" };
  }
  return { ok: true, values };
};

/** Ingredients are single-line: any indented continuation is rejected rather
 * than folded in, since a lead-plus-detail shape belongs to steps only.
 * `rejectTaskItems` reproduces the original per-format behaviour — the
 * demonstrated (bare-heading) format keeps `[ ]`/`[x]` text opaque, while
 * standard Markdown headings treat it as an unsupported checkbox. */
const parseIngredientLines = (
  lines: string[],
  rejectTaskItems: boolean,
): ListParseResult => {
  const values: string[] = [];
  let hasInvalidItem = false;
  let hasUnsupportedStructure = false;
  let hasUnrecognizedContent = false;

  for (const line of lines) {
    if (line.trim() === "") continue;

    const match = line.match(/^[-*+•]\s+(.+)$/u);
    const value = match?.[1];
    if (value !== undefined) {
      if (rejectTaskItems && /^\[[ xX]\](?:\s|$)/u.test(value)) {
        hasUnsupportedStructure = true;
      } else {
        values.push(value);
      }
      continue;
    }

    if (/^\s/u.test(line)) hasUnsupportedStructure = true;
    else if (/^(?:•|[-*+]|\d)/u.test(line)) hasInvalidItem = true;
    else hasUnrecognizedContent = true;
  }

  return finishList(
    values,
    "invalid-ingredient",
    hasInvalidItem,
    hasUnsupportedStructure,
    hasUnrecognizedContent,
  );
};

/** A step is a lead line plus its indented continuation lines, folded into one
 * opaque `\n`-joined string. `dedent` strips only the offset shared by every
 * continuation line, so indentation meaningful *within* the step (e.g. a
 * further-nested sub-point) survives. See `parseIngredientLines` for
 * `rejectTaskItems`. */
const parseStepLines = (
  lines: string[],
  rejectTaskItems: boolean,
): ListParseResult => {
  const values: string[] = [];
  let lead: string | null = null;
  let continuation: string[] = [];
  let pendingBlanks = 0;
  let hasInvalidItem = false;
  let hasUnsupportedStructure = false;
  let hasUnrecognizedContent = false;

  const flush = () => {
    if (lead === null) return;
    const text = [lead, ...dedent(continuation)].join("\n");
    values.push(text.replace(/\n+$/u, ""));
    lead = null;
    continuation = [];
    pendingBlanks = 0;
  };

  for (const line of lines) {
    if (line.trim() === "") {
      if (lead !== null) pendingBlanks += 1;
      continue;
    }

    const marker = line.match(/^\d+[.)]\s+(.+)$/u);
    const value = marker?.[1];
    if (value !== undefined) {
      flush();
      if (rejectTaskItems && /^\[[ xX]\](?:\s|$)/u.test(value)) {
        hasUnsupportedStructure = true;
      } else {
        lead = value;
      }
      continue;
    }

    if (/^\s/u.test(line)) {
      if (lead === null) {
        hasUnsupportedStructure = true;
        continue;
      }
      for (let blank = 0; blank < pendingBlanks; blank += 1) {
        continuation.push("");
      }
      pendingBlanks = 0;
      continuation.push(line);
      continue;
    }

    if (/^(?:•|[-*+]|\d)/u.test(line)) hasInvalidItem = true;
    else hasUnrecognizedContent = true;
  }
  flush();

  return finishList(
    values,
    "invalid-step",
    hasInvalidItem,
    hasUnsupportedStructure,
    hasUnrecognizedContent,
  );
};

type GroupRegion = { name: string | null; lines: string[] };

/** Split a section's lines on group headings one level below the section. */
const splitGroups = (
  lines: string[],
  format: SourceFormat,
  sectionDepth: number,
): GroupRegion[] | null => {
  const groups: GroupRegion[] = [{ name: null, lines: [] }];

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s*(.*)$/u);
    if (!heading?.[1]) {
      groups[groups.length - 1]?.lines.push(line);
      continue;
    }
    // Groups exist only in the heading format; the legacy marker format is
    // read-only legacy and gains no new shapes.
    if (format === "example") return null;
    const name = (heading[2] ?? "").trim();
    if (heading[1].length !== sectionDepth + 1 || name === "") return null;
    groups.push({ name, lines: [] });
  }

  return groups;
};

const parseGroups = (
  lines: string[],
  format: SourceFormat,
  sectionDepth: number,
  parseItems: (lines: string[]) => ListParseResult,
):
  | { ok: true; groups: RecipeGroup[] }
  | { ok: false; reason: RecipeParseFailure } => {
  const regions = splitGroups(lines, format, sectionDepth);
  if (!regions) return { ok: false, reason: "unsupported-content" };

  const groups: RecipeGroup[] = [];
  for (const region of regions) {
    const parsed = parseItems(region.lines);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    groups.push({ name: region.name, items: parsed.values });
  }
  return { ok: true, groups };
};

export function parseRecipeMarkdown(
  body: string,
  pageTitle: string,
): RecipeParseResult {
  // A page created with no body, or one just assigned RECIPE, is an empty
  // recipe rather than a broken one — the editor should offer its fields, not
  // the preservation notice.
  if (body.trim() === "") {
    return {
      ok: true,
      sourceFormat: "markdown",
      value: {
        description: "",
        ingredientGroups: [{ name: null, items: [] }],
        stepGroups: [{ name: null, items: [] }],
        notesMarkdown: "",
      },
    };
  }

  const lines = trimBoundaryBlankLines(normalizeLineEndings(body).split("\n"));
  if (lines[0]?.trim() === pageTitle.trim()) lines.shift();

  // The first marker fixes the format and, for Markdown, the section depth.
  // Anything at another depth is content — that is what lets `### Notes` inside
  // Steps be a group name rather than a section.
  const candidates: SectionMarker[] = [];
  let format: SourceFormat | null = null;
  let sectionDepth = 0;
  const seen = new Set<SectionName>();
  for (const [index, line] of lines.entries()) {
    const marker = parseSectionMarker(line, index);
    if (!marker) continue;
    candidates.push(marker);
    if (format === null) {
      format = marker.format;
      sectionDepth = marker.depth;
    }
    if (marker.format !== format || marker.depth !== sectionDepth) continue;
    seen.add(marker.name);
    // Stop before the notes prose, so marker-shaped lines inside it stay prose.
    if (
      marker.name === "notes" &&
      seen.has("ingredients") &&
      seen.has("steps")
    ) {
      break;
    }
  }

  const accepted = candidates.filter(
    (marker) => marker.format === format && marker.depth === sectionDepth,
  );
  for (const name of sectionNames) {
    if (accepted.some((marker) => marker.name === name)) continue;
    return {
      ok: false,
      reason: candidates.some((marker) => marker.name === name)
        ? "mixed-format"
        : "missing-section",
    };
  }
  if (
    sectionNames.some(
      (name) => accepted.filter((marker) => marker.name === name).length > 1,
    )
  ) {
    return { ok: false, reason: "duplicate-section" };
  }

  const ingredientMarker = accepted.find((m) => m.name === "ingredients");
  const stepMarker = accepted.find((m) => m.name === "steps");
  const notesMarker = accepted.find((m) => m.name === "notes");
  if (!ingredientMarker || !stepMarker || !notesMarker) {
    return { ok: false, reason: "missing-section" };
  }

  if (
    !(
      ingredientMarker.index < stepMarker.index &&
      stepMarker.index < notesMarker.index
    )
  ) {
    return { ok: false, reason: "section-order" };
  }

  const sourceFormat: SourceFormat = format ?? "markdown";
  const rejectTaskItems = sourceFormat === "markdown";
  const ingredients = parseGroups(
    lines.slice(ingredientMarker.index + 1, stepMarker.index),
    sourceFormat,
    sectionDepth,
    (region) => parseIngredientLines(region, rejectTaskItems),
  );

  const steps = parseGroups(
    lines.slice(stepMarker.index + 1, notesMarker.index),
    sourceFormat,
    sectionDepth,
    (region) => parseStepLines(region, rejectTaskItems),
  );
  if (!ingredients.ok && ingredients.reason !== "unsupported-content") {
    return ingredients;
  }
  if (!steps.ok && steps.reason !== "unsupported-content") return steps;
  if (!ingredients.ok) return ingredients;
  if (!steps.ok) return steps;

  return {
    ok: true,
    sourceFormat,
    value: {
      description: joinMarkdown(lines.slice(0, ingredientMarker.index)),
      ingredientGroups: ingredients.groups,
      stepGroups: steps.groups,
      notesMarkdown: joinMarkdown(lines.slice(notesMarker.index + 1)),
    },
  };
}

/** Enforce the lead-group invariant on the way out: the first group is always
 * unnamed, and a group whose name has been cleared merges into the one before
 * it rather than producing an unreadable body. */
const normalizeGroups = (groups: RecipeGroup[]): RecipeGroup[] => {
  const out: RecipeGroup[] = [{ name: null, items: [] }];
  for (const [index, group] of groups.entries()) {
    const name = group.name?.trim() ?? "";
    const items = group.items.filter((item) => item.trim().length > 0);
    if (index === 0 || name === "") {
      out[out.length - 1]?.items.push(...items);
      continue;
    }
    out.push({ name, items });
  }
  return out;
};

/** `## Name` alone when a group holds nothing, heading + blank line + block
 * otherwise. Empty sections and empty groups must still emit their heading so
 * the body keeps parsing. */
const serializeSection = (
  heading: string,
  groups: RecipeGroup[],
  block: (items: string[]) => string,
): string => {
  const [lead, ...named] = normalizeGroups(groups);
  const parts = [`## ${heading}`];

  const leadBlock = lead ? block(lead.items) : "";
  if (leadBlock.length > 0) parts.push(leadBlock);

  for (const group of named) {
    parts.push(`### ${group.name}`);
    const body = block(group.items);
    if (body.length > 0) parts.push(body);
  }

  return parts.join("\n\n");
};

const ingredientBlock = (items: string[]): string =>
  items.map((item) => `- ${normalizeLineEndings(item)}`).join("\n");

/** Each group is its own ordered list, so numbering restarts at 1 inside it. */
const stepBlock = (items: string[]): string =>
  items
    .map((step, index) => {
      const marker = `${index + 1}. `;
      const indent = " ".repeat(marker.length);
      const [lead = "", ...rest] = normalizeLineEndings(step).split("\n");
      return [
        `${marker}${lead}`,
        ...rest.map((line) => (line.trim() === "" ? "" : `${indent}${line}`)),
      ].join("\n");
    })
    .join("\n");

export function serializeRecipeMarkdown(document: RecipeDocument): string {
  const description = joinMarkdown(
    normalizeLineEndings(document.description).split("\n"),
  );
  const notes = joinMarkdown(
    normalizeLineEndings(document.notesMarkdown).split("\n"),
  );

  const sections = [
    ...(description.length > 0 ? [description] : []),
    serializeSection("Ingredients", document.ingredientGroups, ingredientBlock),
    serializeSection("Steps", document.stepGroups, stepBlock),
    notes.length > 0 ? `## Notes\n\n${notes}` : "## Notes",
  ];

  return `${sections.join("\n\n")}\n`;
}
