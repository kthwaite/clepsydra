import { describe, expect, it } from "vitest";
import { contrast, customProps, mainCss, prop, rule } from "./css-contract";

const night = customProps(rule(":root"));
const bone = customProps(rule(".paper"));
const theme = customProps(rule("@theme"));

const NIGHT = {
  "--ground": "#151412",
  "--raise": "#262420",
  "--sink": "#1f1d1a",
  "--ink": "#eee8db",
  "--ink-2": "#cbc5b8",
  "--mute": "#9a948a",
  "--faint": "#57524a",
  "--rule": "#34312c",
  "--accent": "#809cff",
  "--warn": "#e08a6a",
  "--hot": "#e08a6a",
  "--accent-tint": "rgba(128, 156, 255, 0.15)",
  "--quire-ochre": "#d2a95a",
  "--quire-verdigris": "#7fc0a8",
  "--quire-madder": "#e08a80",
  "--quire-indigo": "#b996cc",
  "--quire-slate": "#93afc6",
  "--quire-sepia": "#c19e82",
};

const BONE = {
  "--ground": "#f4efe4",
  "--raise": "#fbf8f2",
  "--sink": "#eae3d3",
  "--ink": "#0e1a3a",
  "--ink-2": "#343b50",
  "--mute": "#5f6372",
  "--faint": "#a9a89f",
  "--rule": "#ddd5c3",
  "--accent": "#1747e6",
  "--warn": "#b3401f",
  "--hot": "#b3401f",
  "--accent-tint": "rgba(23, 71, 230, 0.09)",
  "--quire-ochre": "#8a6424",
  "--quire-verdigris": "#3f7f6a",
  "--quire-madder": "#a2463f",
  "--quire-indigo": "#7a4f8c",
  "--quire-slate": "#4e6a80",
  "--quire-sepia": "#7a5c45",
};

describe("Stone & Lamp palette", () => {
  it("defines charcoal on :root", () => {
    expect(night).toMatchObject(NIGHT);
  });

  it("defines bone on .paper", () => {
    expect(bone).toMatchObject(BONE);
  });

  it("keeps no Vessel or shadcn names", () => {
    const LEGACY =
      /^--(paper(-2|-edge)?|ink-mute|ink-faint|cool|highlight|grid|accent-deep|rule-soft|bar-.*|bg(-\d)?|ink-[34]|row-h|gap|pad|fs(-s|-xs)?)$/;
    for (const body of [night, bone]) {
      expect(Object.keys(body).filter((k) => LEGACY.test(k))).toEqual([]);
    }
    const LEGACY_THEME =
      /^--(color-(paper.*|ink-mute|ink-faint|cool|highlight|accent-deep|rule-soft|bar-.*|background|foreground|card.*|popover.*|primary.*|secondary.*|muted.*|accent-foreground|destructive.*|border|input|ring)|font-(body|heading|slab|serif-sc)|space-.*|text-fs.*)$/;
    expect(Object.keys(theme).filter((k) => LEGACY_THEME.test(k))).toEqual([]);
  });

  it("wires every Tailwind colour through a bare property", () => {
    const expected: Record<string, string> = {
      "--color-ground": "var(--ground)",
      "--color-raise": "var(--raise)",
      "--color-sink": "var(--sink)",
      "--color-ink": "var(--ink)",
      "--color-ink-2": "var(--ink-2)",
      "--color-mute": "var(--mute)",
      "--color-faint": "var(--faint)",
      "--color-rule": "var(--rule)",
      "--color-accent": "var(--accent)",
      "--color-accent-tint": "var(--accent-tint)",
      "--color-warn": "var(--warn)",
      "--color-hot": "var(--hot)",
      "--color-scrim": "var(--scrim)",
    };
    expect(theme).toMatchObject(expected);
    // .paper re-binds bare properties only; no --color-* duplication.
    expect(Object.keys(bone).filter((k) => k.startsWith("--color-"))).toEqual(
      [],
    );
  });

  it("has no accent presets (cobalt is fixed)", () => {
    expect(mainCss).not.toContain("[data-accent");
  });

  it("retires barbican orange", () => {
    expect(mainCss.toLowerCase()).not.toContain("#ee7733");
  });

  it("rounds to 12px and keeps shadows soft (no hard offsets)", () => {
    expect(theme["--radius"]).toBe("12px");
    for (const k of [
      "--shadow-sm",
      "--shadow-md",
      "--shadow-lg",
      "--shadow-xl",
    ]) {
      expect(theme[k]).toMatch(/^var\(--elev-[1-4]\)$/);
    }
    for (const body of [night, bone]) {
      for (const k of ["--elev-1", "--elev-2", "--elev-3", "--elev-4"]) {
        expect(body[k]).toMatch(/^0 \d+px \d+px /);
      }
    }
  });

  it.each(["::selection", ".cl-root *::selection"])(
    "paints %s with the accent tint, keeping text colour",
    (sel) => {
      const r = rule(sel);
      expect(prop(r, "background")).toBe("var(--accent-tint)");
      expect(prop(r, "color")).toBe("inherit");
    },
  );

  it.each([
    ["charcoal", NIGHT],
    ["bone", BONE],
  ])("keeps mute and accent legible in %s", (_name, t) => {
    for (const surface of [t["--ground"], t["--raise"], t["--sink"]]) {
      expect(contrast(t["--mute"], surface)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(t["--accent"], t["--ground"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["--ink"], t["--ground"])).toBeGreaterThanOrEqual(7);
  });
});

describe("code token colours", () => {
  // Strings and literals sit on the code block's sink; the quire hues are too
  // light for 13px text there in bone (5.3 review I1).
  it("reads at AA on sink in both themes", () => {
    for (const vars of [night, bone]) {
      const sink = vars["--sink"] as string;
      for (const token of ["--code-string", "--code-literal"]) {
        expect(vars[token], token).toBeDefined();
        expect(
          contrast(vars[token] as string, sink),
          token,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
