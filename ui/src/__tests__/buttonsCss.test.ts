import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prop, rule } from "./css-contract";

const SRC = path.resolve(import.meta.dirname, "..");
const SELF = /\.test\.tsx?$|__tests__/;

/** Every non-test .ts/.tsx file under ui/src. */
function sourceFiles(dir: string = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name) || SELF.test(full)) return [];
    return [full];
  });
}

describe("the .cl-btn stopgap is gone (phase 5.6: buttons are ui/button)", () => {
  it("leaves no .cl-btn rule in main.css", () => {
    for (const selector of [
      ".cl-btn",
      ".cl-btn:hover",
      ".cl-btn:focus-visible",
      ".cl-btn-hot",
      ".cl-btn-hot:hover",
    ]) {
      expect(() => rule(selector)).toThrow();
    }
  });

  it("leaves no source file naming cl-btn", () => {
    const offenders = sourceFiles().filter((file) =>
      readFileSync(file, "utf8").includes("cl-btn"),
    );
    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
  });

  it("rules the assistant turn in cobalt, not the Vessel --cool", () => {
    const turn = rule(
      '.ai-conversation-turn[data-role="assistant"] .ai-conversation-turn__content',
    );
    expect(prop(turn, "border-inline-start")).toBe("2px solid var(--accent)");
  });
});
