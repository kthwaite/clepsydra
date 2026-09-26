import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mainCss } from "./css-contract";

const src = path.resolve(import.meta.dirname, "..");

/** Classes composed at runtime, so their full name never appears in source. */
const DYNAMIC = new Set<string>([
  "ai-conversation--read", // `ai-conversation--${conversationMode}` in Folio
  "ai-conversation--edit",
]);

/** Every class name used in a selector anywhere in main.css. */
function selectorClasses(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const names = new Set<string>();
  for (const m of text.matchAll(/(^|[{};])([^{};]*)\{/g)) {
    const selector = m[2].replace(/\[[^\]]*\]/g, "").trim();
    if (selector.startsWith("@") || /^[\d.%\s,]+$|^(from|to)$/.test(selector))
      continue;
    for (const c of selector.matchAll(/\.(-?[a-zA-Z_][\w-]*)/g)) {
      names.add(c[1]);
    }
  }
  return [...names].sort();
}

function sourceCorpus(): string {
  const parts: string[] = [
    readFileSync(path.resolve(src, "../index.html"), "utf8"),
  ];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        /\.(tsx?|mdx|js)$/.test(entry.name) &&
        !/(\.test\.|__tests__)/.test(full)
      )
        parts.push(readFileSync(full, "utf8"));
    }
  };
  walk(src);
  walk(path.resolve(src, "../public"));
  return parts.join("\n");
}

describe("main.css", () => {
  const corpus = sourceCorpus();
  const classes = selectorClasses(mainCss);

  it("finds the class selectors", () => {
    expect(classes).toContain("paper");
    expect(classes).toContain("feed-entry-content");
  });

  it.each(classes)("uses .%s somewhere in the app", (name) => {
    if (DYNAMIC.has(name)) return;
    const used = new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(corpus);
    expect(used).toBe(true);
  });
});

/** Innermost `selector { declarations }` pairs, comments stripped. */
function innerRules(css: string): Array<{ selector: string; body: string }> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...text.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].replace(/\s+/g, " ").trim(),
    body: m[2],
  }));
}

describe("main.css carries no Vessel chrome", () => {
  const rules = innerRules(mainCss);

  it("sets no caps", () => {
    const caps = rules.filter((r) =>
      /text-transform:\s*uppercase/.test(r.body),
    );
    expect(caps.map((r) => r.selector)).toEqual([]);
  });

  it("keeps mono to code (spec §3.2)", () => {
    const CODE = /\b(pre|code|kbd|samp)\b|data-code-editor|folio-math--invalid/;
    const mono = rules.filter(
      (r) => /var\(--font-mono\)/.test(r.body) && !CODE.test(r.selector),
    );
    expect(mono.map((r) => r.selector)).toEqual([]);
  });
});
