import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = path.resolve(import.meta.dirname, "../../..");
const ALLOWED = new Set(["components/codex/moon/MoonGlobe.tsx"]);
/** Static `import … from "three"` / `export … from "three"` / bare `import "three"`. */
const STATIC_THREE =
  /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']three(?:\/[^"']*)?["']|^\s*import\s*["']three(?:\/[^"']*)?["']/m;
/** A value (non-type) static import of the MoonGlobe module itself. */
const STATIC_GLOBE =
  /^\s*import\s+(?!type\b)[^;]*?\bfrom\s*["'][^"']*\/MoonGlobe["']/m;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("three.js stays in the lazy MoonGlobe chunk", () => {
  const files = walk(src).map((f) =>
    path.relative(src, f).split(path.sep).join("/"),
  );

  it("only MoonGlobe.tsx statically imports three", () => {
    const offenders = files.filter(
      (f) =>
        !ALLOWED.has(f) &&
        STATIC_THREE.test(readFileSync(path.join(src, f), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("app code reaches MoonGlobe only through a dynamic import", () => {
    const offenders = files.filter(
      (f) =>
        !/\.(test|stories)\.tsx?$/.test(f) &&
        STATIC_GLOBE.test(readFileSync(path.join(src, f), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("the guard pattern catches a static import", () => {
    expect(STATIC_THREE.test('import { Mesh } from "three";')).toBe(true);
    expect(STATIC_THREE.test('import type { Mesh } from "three";')).toBe(true);
    expect(STATIC_THREE.test('const t = await import("three");')).toBe(false);
    expect(STATIC_GLOBE.test('import MoonGlobe from "./MoonGlobe";')).toBe(
      true,
    );
    expect(
      STATIC_GLOBE.test('import type { MoonGlobeProps } from "./MoonGlobe";'),
    ).toBe(false);
  });
});
