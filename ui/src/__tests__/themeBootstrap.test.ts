import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_COLOR } from "#/lib/theme";

const script = readFileSync(
  path.resolve(import.meta.dirname, "../../public/theme-bootstrap.js"),
  "utf8",
);

function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, String(v));
    },
  };
}

function run(seed: Record<string, string> = {}) {
  vi.stubGlobal("localStorage", fakeStorage(seed));
  new Function(script)();
}

const meta = () =>
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');

beforeEach(() => {
  const root = document.documentElement;
  root.className = "";
  root.removeAttribute("data-accent");
  root.style.colorScheme = "";
  meta()?.remove();
  const tag = document.createElement("meta");
  tag.name = "theme-color";
  tag.content = "#000000";
  document.head.append(tag);
});

afterEach(() => vi.unstubAllGlobals());

describe("theme-bootstrap.js (pre-paint) agrees with lib/theme", () => {
  it("paints bone by default", () => {
    run();
    expect(document.documentElement.classList.contains("paper")).toBe(true);
    expect(meta()?.content).toBe(THEME_COLOR.light);
  });

  it("no longer hides chrome for a stored diegetic-off preference", () => {
    run({ "clepsydra.diegetic": "off" });
    expect(document.documentElement.hasAttribute("data-diegetic")).toBe(false);
  });

  it("paints charcoal for a stored dark preference", () => {
    run({ "clepsydra.theme": "dark" });
    expect(document.documentElement.classList.contains("paper")).toBe(false);
    expect(meta()?.content).toBe(THEME_COLOR.dark);
  });
});
