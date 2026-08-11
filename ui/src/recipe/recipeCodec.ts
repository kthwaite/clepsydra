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

const parseListLines = (
  lines: string[],
  pattern: RegExp,
  invalidReason: "invalid-ingredient" | "invalid-step",
  rejectTaskItems: boolean,
): ListParseResult => {
  const values: string[] = [];
  let hasInvalidItem = false;
  let hasUnsupportedStructure = false;
  let hasUnrecognizedContent = false;

  for (const line of lines) {
    if (line.trim() === "") continue;

    const match = line.match(pattern);
    const value = match?.[1];
    if (value !== undefined) {
      if (rejectTaskItems && /^\[[ xX]\](?:\s|$)/u.test(value)) {
        hasUnsupportedStructure = true;
      } else {
        values.push(value);
      }
      continue;
    }

    if (/^\s/u.test(line)) {
      hasUnsupportedStructure = true;
    } else if (/^(?:•|[-*+]|\d)/u.test(line)) {
      hasInvalidItem = true;
    } else {
      hasUnrecognizedContent = true;
    }
  }

  if (
    hasInvalidItem ||
    (values.length === 0 && hasUnrecognizedContent)
  ) {
    return { ok: false, reason: invalidReason };
  }
  if (hasUnsupportedStructure || hasUnrecognizedContent) {
    return { ok: false, reason: "unsupported-content" };
  }

  return { ok: true, values };
};

export function parseRecipeMarkdown(
  body: string,
  pageTitle: string,
): RecipeParseResult {
  const lines = trimBoundaryBlankLines(
    normalizeLineEndings(body).split("\n"),
  );
  if (lines[0]?.trim() === pageTitle.trim()) lines.shift();

  const markers: SectionMarker[] = [];
  for (const [index, line] of lines.entries()) {
    const marker = parseSectionMarker(line, index);
    if (marker) markers.push(marker);
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
  const ingredients = parseListLines(
    lines.slice(ingredientMarker.index + 1, stepMarker.index),
    sourceFormat === "example" ? /^•\s+(.+)$/u : /^[-*+]\s+(.+)$/u,
    "invalid-ingredient",
    sourceFormat === "markdown",
  );

  const steps = parseListLines(
    lines.slice(stepMarker.index + 1, notesMarker.index),
    /^\d+[.)]\s+(.+)$/u,
    "invalid-step",
    sourceFormat === "markdown",
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

export function serializeRecipeMarkdown(document: RecipeDocument): string {
  const description = joinMarkdown(
    normalizeLineEndings(document.description).split("\n"),
  );
  const ingredients = document.ingredients
    .filter((ingredient) => ingredient.length > 0)
    .map((ingredient) => `• ${normalizeLineEndings(ingredient)}`);
  const steps = document.steps
    .filter((step) => step.length > 0)
    .map((step, index) => `${index + 1}. ${normalizeLineEndings(step)}`);
  const notes = joinMarkdown(
    normalizeLineEndings(document.notesMarkdown).split("\n"),
  );

  const sections = [
    ...(description.length > 0 ? [description] : []),
    ["INGREDIENTS", ...ingredients].join("\n"),
    ["STEPS", ...steps].join("\n"),
    notes.length > 0 ? `NOTES\n${notes}` : "NOTES",
  ];

  return `${sections.join("\n\n")}\n`;
}
