import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = path.resolve(import.meta.dirname, "..");
const uiDir = path.join(src, "components/ui");

/** Files deliberately outside the guard (none since phase 4.1). */
const OUT_OF_SCOPE = new Set<string>([]);

/** Not yet restyled; each task removes its files. `it.fails` makes a file
 *  that is already clean fail, forcing its removal here. */
const PENDING = new Set<string>([]);

const FORBIDDEN: Array<[string, RegExp]> = [
  ["uppercase", /\buppercase\b/],
  ["tracking", /\btracking-/],
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
];

const files = [
  ...readdirSync(uiDir)
    .filter((f) => f.endsWith(".tsx") && !f.includes(".stories."))
    .filter((f) => !OUT_OF_SCOPE.has(f)),
  "../codex/TabPreviewCard.tsx",
  "../codex/CodexModalShell.tsx",
  "../codex/CommandPalette.tsx",
  "../codex/Section.tsx",
  "../codex/Tick.tsx",
].filter((f) => {
  try {
    readFileSync(path.join(uiDir, f));
    return true;
  } catch {
    return false; // Section/Tick appear in Task 2
  }
});

function offences(file: string): string[] {
  const text = readFileSync(path.join(uiDir, file), "utf8");
  return FORBIDDEN.filter(([, re]) => re.test(text)).map(([name]) => name);
}

describe("Stone & Lamp primitives carry no Vessel chrome", () => {
  for (const file of files) {
    const run = PENDING.has(file) ? it.fails : it;
    run(`${file} is clean`, () => {
      expect(offences(file)).toEqual([]);
    });
  }

  it("every pending file still exists", () => {
    for (const file of PENDING) {
      expect(files).toContain(file);
    }
  });
});
