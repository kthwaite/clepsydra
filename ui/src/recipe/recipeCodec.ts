import { dedent } from "#/recipe/recipeText";

export type RecipeDocument = {
  description: string;
  ingredients: string[];
  steps: string[];
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
type SectionMarker = {
  name: SectionName;
  format: SourceFormat;
  depth: number | null;
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
      depth: null,
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
        ingredients: [],
        steps: [],
        notesMarkdown: "",
      },
    };
  }

  const lines = trimBoundaryBlankLines(normalizeLineEndings(body).split("\n"));
  if (lines[0]?.trim() === pageTitle.trim()) lines.shift();

  const markers: SectionMarker[] = [];
  let foundIngredients = false;
  let foundSteps = false;
  for (const [index, line] of lines.entries()) {
    const marker = parseSectionMarker(line, index);
    if (!marker) continue;

    markers.push(marker);
    if (marker.name === "ingredients") foundIngredients = true;
    if (marker.name === "steps") foundSteps = true;
    if (marker.name === "notes" && foundIngredients && foundSteps) break;
  }

  const ingredientMarkers = markers.filter(
    (marker) => marker.name === "ingredients",
  );
  const stepMarkers = markers.filter((marker) => marker.name === "steps");
  const notesMarkers = markers.filter((marker) => marker.name === "notes");
  const markerGroups = [ingredientMarkers, stepMarkers, notesMarkers];

  if (markerGroups.some((group) => group.length === 0)) {
    return { ok: false, reason: "missing-section" };
  }
  if (markerGroups.some((group) => group.length > 1)) {
    return { ok: false, reason: "duplicate-section" };
  }

  const ingredientMarker = ingredientMarkers[0];
  const stepMarker = stepMarkers[0];
  const notesMarker = notesMarkers[0];
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

  if (
    ingredientMarker.format !== stepMarker.format ||
    stepMarker.format !== notesMarker.format ||
    (ingredientMarker.format === "markdown" &&
      (ingredientMarker.depth !== stepMarker.depth ||
        stepMarker.depth !== notesMarker.depth))
  ) {
    return { ok: false, reason: "mixed-format" };
  }

  const sourceFormat = ingredientMarker.format;
  const rejectTaskItems = sourceFormat === "markdown";
  const ingredients = parseIngredientLines(
    lines.slice(ingredientMarker.index + 1, stepMarker.index),
    rejectTaskItems,
  );

  const steps = parseStepLines(
    lines.slice(stepMarker.index + 1, notesMarker.index),
    rejectTaskItems,
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
      ingredients: ingredients.values,
      steps: steps.values,
      notesMarkdown: joinMarkdown(lines.slice(notesMarker.index + 1)),
    },
  };
}

/** `## Name` alone when the section is empty, `## Name` + blank line + block
 * otherwise. Empty sections must still emit their heading so the body keeps
 * parsing. */
const serializeSection = (heading: string, block: string): string =>
  block.length > 0 ? `## ${heading}\n\n${block}` : `## ${heading}`;

export function serializeRecipeMarkdown(document: RecipeDocument): string {
  const description = joinMarkdown(
    normalizeLineEndings(document.description).split("\n"),
  );
  const ingredients = document.ingredients
    .filter((ingredient) => ingredient.trim().length > 0)
    .map((ingredient) => `- ${normalizeLineEndings(ingredient)}`)
    .join("\n");
  const steps = document.steps
    .filter((step) => step.trim().length > 0)
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
  const notes = joinMarkdown(
    normalizeLineEndings(document.notesMarkdown).split("\n"),
  );

  const sections = [
    ...(description.length > 0 ? [description] : []),
    serializeSection("Ingredients", ingredients),
    serializeSection("Steps", steps),
    serializeSection("Notes", notes),
  ];

  return `${sections.join("\n\n")}\n`;
}
