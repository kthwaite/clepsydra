import { readFileSync } from "node:fs";
import path from "node:path";

/** Raw text of ui/src/main.css. */
export const mainCss = readFileSync(
  path.resolve(import.meta.dirname, "../main.css"),
  "utf8",
);

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

type Rule = { selector: string; body: string };

/** Top-level `selector { body }` pairs, comments stripped, selectors
 *  whitespace-normalised. `@import …;` statements are skipped. */
export function topLevelRules(css: string = mainCss): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  let depth = 0;
  let selStart = 0;
  let bodyStart = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      if (depth === 0) {
        rules.push({ selector: norm(src.slice(selStart, i)), body: "" });
        bodyStart = i + 1;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        rules[rules.length - 1].body = src.slice(bodyStart, i);
        selStart = i + 1;
      }
    } else if (ch === ";" && depth === 0) {
      selStart = i + 1;
    }
  }
  return rules;
}

/** Body of the first top-level rule whose selector equals `selector`
 *  (whitespace-insensitive). Throws when absent so tests fail loudly. */
export function rule(selector: string, css: string = mainCss): string {
  const want = norm(selector);
  const found = topLevelRules(css).find((r) => r.selector === want);
  if (!found) throw new Error(`main.css has no top-level rule "${want}"`);
  return found.body;
}

/** `--name: value;` pairs in a rule body; values whitespace-normalised and
 *  lower-cased. */
export function customProps(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = norm(m[2]).toLowerCase();
  }
  return out;
}

/** A plain property (e.g. `font-family`) in a rule body, normalised. */
export function prop(body: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+);`).exec(body);
  return m ? norm(m[1]) : undefined;
}

/** WCAG 2.1 contrast ratio between two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5]
      .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
