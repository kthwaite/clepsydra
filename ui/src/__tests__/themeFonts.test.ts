import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { customProps, mainCss, prop, rule } from "./css-contract";

const theme = customProps(rule("@theme"));
const pkg = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../../package.json"), "utf8"),
) as { dependencies: Record<string, string> };

describe("Stone & Lamp fonts", () => {
  it("sets Geist as sans, Instrument Serif as serif, JetBrains Mono as mono", () => {
    expect(theme["--font-sans"]).toMatch(/^"geist variable"/);
    expect(theme["--font-serif"]).toMatch(/^"instrument serif"/);
    expect(theme["--font-mono"]).toMatch(/^"jetbrains mono variable"/);
  });

  it("imports the faces and drops Inter", () => {
    expect(mainCss).toContain('@import "@fontsource-variable/geist";');
    expect(mainCss).toContain(
      '@import "@fontsource/instrument-serif/400.css";',
    );
    expect(mainCss).toContain(
      '@import "@fontsource/instrument-serif/400-italic.css";',
    );
    expect(mainCss).not.toContain("@fontsource-variable/inter");
    expect(pkg.dependencies).toHaveProperty("@fontsource-variable/geist");
    expect(pkg.dependencies).toHaveProperty("@fontsource/instrument-serif");
    expect(pkg.dependencies).not.toHaveProperty("@fontsource-variable/inter");
  });

  it("sets body in sans at 14px without global tabular figures", () => {
    const body = rule("body");
    expect(prop(body, "font-family")).toBe("var(--font-sans)");
    expect(prop(body, "font-size")).toBe("14px");
    expect(prop(body, "font-feature-settings") ?? "").not.toContain("tnum");
  });

  it("remaps .cl-mono and .cl-cap to sans (stopgap until the phase 5 sweep)", () => {
    expect(prop(rule(".cl-mono"), "font-family")).toBe("var(--font-sans)");
    const cap = rule(".cl-cap");
    expect(prop(cap, "font-family")).toBe("var(--font-sans)");
    expect(prop(cap, "text-transform")).toBe("none");
    expect(prop(cap, "letter-spacing")).toBe("normal");
  });

  it("keeps the app frame (.cl-root) in sans at 14px, not mono", () => {
    const root = rule(".cl-root");
    expect(prop(root, "font-family")).toBe("var(--font-sans)");
    expect(prop(root, "font-size")).toBe("14px");
  });

  it("keeps Vessel buttons in sans until Button replaces them (phase 3)", () => {
    expect(prop(rule(".cl-btn"), "font-family")).toBe("var(--font-sans)");
  });

  it("keeps code monospace, including code marked .cl-mono", () => {
    const code = rule(
      ":where(pre, code, kbd, samp), pre.cl-mono, code.cl-mono, kbd.cl-mono, samp.cl-mono",
    );
    expect(prop(code, "font-family")).toBe("var(--font-mono)");
  });
});
