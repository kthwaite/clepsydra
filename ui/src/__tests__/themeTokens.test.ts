import { describe, expect, it } from "vitest";
import { contrast, customProps, mainCss, rule } from "./css-contract";

const night = customProps(rule(":root"));
const bone = customProps(rule(".paper"));
const theme = customProps(rule("@theme"));

const NIGHT = {
  "--paper": "#151412",
  "--paper-2": "#262420",
  "--paper-edge": "#1f1d1a",
  "--ink": "#eee8db",
  "--ink-2": "#cbc5b8",
  "--ink-mute": "#9a948a",
  "--ink-faint": "#57524a",
  "--rule": "#34312c",
  "--accent": "#809cff",
  "--cool": "#809cff",
  "--warn": "#e08a6a",
  "--hot": "#e08a6a",
  "--highlight": "rgba(128, 156, 255, 0.15)",
  "--quire-ochre": "#d2a95a",
  "--quire-verdigris": "#7fc0a8",
  "--quire-madder": "#e08a80",
  "--quire-indigo": "#b996cc",
  "--quire-slate": "#93afc6",
  "--quire-sepia": "#c19e82",
};

const BONE = {
  "--paper": "#f4efe4",
  "--paper-2": "#fbf8f2",
  "--paper-edge": "#eae3d3",
  "--ink": "#0e1a3a",
  "--ink-2": "#343b50",
  "--ink-mute": "#5f6372",
  "--ink-faint": "#a9a89f",
  "--rule": "#ddd5c3",
  "--accent": "#1747e6",
  "--cool": "#1747e6",
  "--warn": "#b3401f",
  "--hot": "#b3401f",
  "--highlight": "rgba(23, 71, 230, 0.09)",
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

  it("exposes the new role aliases on :root", () => {
    expect(night).toMatchObject({
      "--ground": "var(--paper)",
      "--raise": "var(--paper-2)",
      "--sink": "var(--paper-edge)",
      "--mute": "var(--ink-mute)",
      "--faint": "var(--ink-faint)",
      "--accent-tint": "var(--highlight)",
    });
  });

  it("wires every Tailwind colour through a bare property", () => {
    const expected: Record<string, string> = {
      "--color-paper": "var(--paper)",
      "--color-paper-2": "var(--paper-2)",
      "--color-paper-edge": "var(--paper-edge)",
      "--color-ink": "var(--ink)",
      "--color-ink-2": "var(--ink-2)",
      "--color-ink-mute": "var(--ink-mute)",
      "--color-ink-faint": "var(--ink-faint)",
      "--color-accent": "var(--accent)",
      "--color-cool": "var(--cool)",
      "--color-warn": "var(--warn)",
      "--color-hot": "var(--hot)",
      "--color-rule": "var(--rule)",
      "--color-highlight": "var(--highlight)",
      "--color-ground": "var(--paper)",
      "--color-raise": "var(--paper-2)",
      "--color-sink": "var(--paper-edge)",
      "--color-mute": "var(--ink-mute)",
      "--color-faint": "var(--ink-faint)",
      "--color-accent-tint": "var(--highlight)",
      "--color-background": "var(--paper)",
      "--color-foreground": "var(--ink)",
      "--color-primary": "var(--accent)",
      "--color-ring": "var(--accent)",
      "--color-border": "var(--rule)",
    };
    expect(theme).toMatchObject(expected);
    // .paper re-binds bare properties only; no --color-* duplication.
    expect(Object.keys(bone).filter((k) => k.startsWith("--color-"))).toEqual(
      [],
    );
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

  it.each([
    ["charcoal", NIGHT],
    ["bone", BONE],
  ])("keeps mute and accent legible in %s", (_name, t) => {
    for (const surface of [t["--paper"], t["--paper-2"], t["--paper-edge"]]) {
      expect(contrast(t["--ink-mute"], surface)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(t["--accent"], t["--paper"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["--ink"], t["--paper"])).toBeGreaterThanOrEqual(7);
  });
});
