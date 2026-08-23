/** Conversion between a recipe textarea's text and its item list.
 *
 * The edit view is a plain textarea so a block of ingredients or steps can be
 * pasted straight from a web page. Whatever list marker came with that paste is
 * stripped here rather than being stored as part of the item — the codec owns
 * markers, items are opaque text. */

/** A leading unordered bullet or ordered marker, as pasted from elsewhere.
 * Requires trailing whitespace so a quantity like `1/2 tsp` is never mistaken
 * for a numbered item. */
const LEADING_MARKER = /^\s*(?:[-*+•]|\d+[.)])\s+/u;

const normalizeLineEndings = (value: string): string =>
  value.replace(/\r\n?/g, "\n");

export function itemsFromText(text: string): string[] {
  return normalizeLineEndings(text)
    .split("\n")
    .map((line) => line.replace(LEADING_MARKER, "").trim())
    .filter((line) => line.length > 0);
}

export function textFromItems(items: string[]): string {
  return items.join("\n");
}

const STEP_INDENT = "  ";

/** Strip the shallowest indent shared by a step's continuation lines, so
 * indentation *within* a step survives while its offset from the marker does
 * not. Blank lines carry no indent and stay blank. */
export const dedent = (lines: string[]): string[] => {
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => /^[ \t]*/u.exec(line)?.[0].length ?? 0);
  const shallowest = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) =>
    line.trim() === "" ? "" : line.slice(shallowest),
  );
};

/** An unindented line opens a step; indented lines belong to the step above.
 * Numbers are never rendered into the textarea, so any that arrive with a paste
 * are stripped rather than fought with. */
export function stepsFromText(text: string): string[] {
  const steps: string[] = [];
  let lead: string | null = null;
  let continuation: string[] = [];

  const flush = () => {
    if (lead === null) return;
    steps.push([lead, ...dedent(continuation)].join("\n").replace(/\n+$/u, ""));
    lead = null;
    continuation = [];
  };

  for (const line of normalizeLineEndings(text).split("\n")) {
    if (line.trim() === "") {
      if (lead !== null) continuation.push("");
      continue;
    }
    if (/^\s/u.test(line) && lead !== null) {
      continuation.push(line);
      continue;
    }
    flush();
    lead = line.replace(LEADING_MARKER, "").trim();
  }
  flush();

  return steps.filter((step) => step.trim().length > 0);
}

export function textFromSteps(steps: string[]): string {
  return steps
    .map((step) =>
      normalizeLineEndings(step)
        .split("\n")
        .map((line, index) =>
          index === 0 || line.trim() === "" ? line : `${STEP_INDENT}${line}`,
        )
        .join("\n"),
    )
    .join("\n");
}
