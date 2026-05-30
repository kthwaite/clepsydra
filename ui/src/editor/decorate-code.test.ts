import { describe, expect, it } from "vitest";
import { decorateCode } from "./decorate-code";

const codeBlock = (language: string, text: string) => ({
  type: "code-block" as const,
  language,
  children: [{ text }],
});

describe("decorateCode", () => {
  it("returns [] for non-code-block nodes", () => {
    const para = { type: "paragraph", children: [{ text: "hi" }] };
    expect(decorateCode([para as any, [0]])).toEqual([]);
  });

  it("returns [] for a code-block with no language", () => {
    const node = { type: "code-block" as const, children: [{ text: "const x = 1;" }] };
    expect(decorateCode([node as any, [0]])).toEqual([]);
  });

  it("returns [] for an unknown/unregistered language (no throw)", () => {
    const node = codeBlock("not-a-real-lang", "const x = 1;");
    expect(decorateCode([node as any, [0]])).toEqual([]);
  });

  it("emits token ranges into child text 0 with correct offsets", () => {
    const node = codeBlock("javascript", "const x = 1;");
    const ranges = decorateCode([node as any, [3]]);
    expect(ranges.length).toBeGreaterThan(0);
    for (const r of ranges) {
      expect(r.anchor.path).toEqual([3, 0]);
      expect(r.focus.path).toEqual([3, 0]);
      expect(r.focus.offset).toBeGreaterThan(r.anchor.offset);
      expect(typeof r.token).toBe("string");
    }
    const kw = ranges.find((r) => r.anchor.offset === 0);
    expect(kw?.token).toBe("keyword");
    expect(kw?.focus.offset).toBe(5);
  });
});
