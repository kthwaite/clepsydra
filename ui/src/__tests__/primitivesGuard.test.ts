import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = path.resolve(import.meta.dirname, "..");

/** Sanctioned exceptions: file (relative to src) → rule names it may use.
 *  Mono belongs to code only (spec §3.2); code blocks get it from main.css. */
const ALLOW: Record<string, string[]> = {};

/** Not yet clean; each task removes its files. `it.fails` makes a file
 *  that is already clean fail, forcing its removal here. */
const PENDING = new Set<string>([]);

const FORBIDDEN: Array<[string, RegExp]> = [
  ["uppercase", /\buppercase\b/],
  // Negative tracking tightens large serif display type (mockup); Vessel's
  // chrome was positive tracking on caps.
  ["tracking", /\btracking-(?!\[-)/],
  ["cl-mono", /\bcl-mono\b/],
  ["cl-serif", /\bcl-serif\b/],
  ["font-mono", /\bfont-mono\b/],
  ["border-ink", /\bborder-ink\b/],
  ["border-[…]", /\bborder-\[/],
  ["border-rule", /\bborder-rule\b/],
  ["border-border", /\bborder-border\b/],
  ["bare border", /["'\s]border["'\s]/],
  // Unprefixed only: a breakpoint variant (max-md:rounded-none for a
  // full-screen mobile sheet) is a layout choice, not Vessel chrome.
  ["rounded-none", /(^|["'\s])rounded-none\b/],
  ["9–11px type", /\btext-\[(9|10|11)px\]/],
  ["paper-2", /\bpaper-2\b/],
  ["ink-mute", /\bink-mute\b/],
  ["muted-foreground", /\bmuted-foreground\b/],
  // Phase 5.6: the .cl-btn stopgap CSS is gone, and Vessel-only variables
  // (cool = accent, paper, bar-*, ink-3, bg) have Stone & Lamp role names.
  ["cl-btn", /\bcl-btn\b/],
  ["cl-marg", /\bcl-marg\b/],
  [
    "Vessel var",
    /var\(--(ink-3|ink-4|ink-mute|ink-faint|bg|paper|cool|bar-|highlight|grid|accent-deep|rule-soft)/,
  ],
  ["cool", /\b(bg|text|border|fill|stroke)-cool\b/],
  // Phase 6: Vessel and shadcn colour names are gone from the theme, so a
  // class using one would silently render no colour.
  [
    "legacy colour",
    /\b(bg|text|border|decoration|fill|stroke|ring|outline|shadow|from|to|via|divide|placeholder|caret)-(paper(-2|-edge)?|ink-mute|ink-faint|highlight|accent-deep|rule-soft|background|foreground|card|popover|primary|secondary|muted|destructive|input)\b/,
  ],
  ["font alias", /\bfont-(heading|body|slab|serif-sc)\b/],
];

const SKIP = /(\.test\.|__tests__|routeTree\.gen\.ts$|schema\.d\.ts$)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx?|mdx)$/.test(entry.name) && !SKIP.test(full)) {
      out.push(path.relative(src, full));
    }
  }
  return out;
}

const files = walk(src).sort();

function offences(file: string): string[] {
  const text = readFileSync(path.join(src, file), "utf8");
  const allowed = ALLOW[file] ?? [];
  return FORBIDDEN.filter(
    ([name, re]) => !allowed.includes(name) && re.test(text),
  ).map(([name]) => name);
}

describe("the UI source carries no Vessel chrome", () => {
  it("scans the whole tree", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain("components/ui/button.tsx");
    expect(files).toContain("docs/content/lsp.mdx");
  });

  for (const file of files) {
    const run = PENDING.has(file) ? it.fails : it;
    run(`${file} is clean`, () => {
      expect(offences(file)).toEqual([]);
    });
  }

  it("every pending and allowed file still exists", () => {
    for (const file of [...PENDING, ...Object.keys(ALLOW)]) {
      expect(files).toContain(file);
    }
  });
});
