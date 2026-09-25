import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { customProps, rule } from "./css-contract";

const read = (p: string) =>
  readFileSync(path.resolve(import.meta.dirname, "..", p), "utf8");

describe("scrim token", () => {
  it("dims with navy in bone and black in charcoal (ink is light in charcoal)", () => {
    expect(customProps(rule(".paper"))["--scrim"]).toBe("rgb(14 26 58 / 0.26)");
    expect(customProps(rule(":root"))["--scrim"]).toBe("rgb(0 0 0 / 0.45)");
    expect(customProps(rule("@theme"))["--color-scrim"]).toBe("var(--scrim)");
  });

  it.each([
    "components/ui/dialog.tsx",
    "components/codex/CodexModalShell.tsx",
    "components/codex/DesktopCodexFrame.tsx",
  ])("%s dims with the scrim token, not ink", (file) => {
    const src = read(file);
    expect(src).toContain("bg-scrim");
    expect(src).not.toMatch(/bg-ink\/\d/);
  });
});
