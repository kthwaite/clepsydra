import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** The Vite scaffold shipped a `ui` title and a `/vite.svg` icon that was
 * never in `public/`, so every tab showed a 404 and the wrong name. These
 * guard the shell that rust-embed serves from `ui/dist`. */
const UI_ROOT = path.resolve(import.meta.dirname, "../..");
const shell = readFileSync(path.join(UI_ROOT, "index.html"), "utf8");

describe("index.html", () => {
  it("names the app in the browser tab", () => {
    expect(shell).toContain("<title>Clepsydra</title>");
  });

  it("links an icon that ships with the build", () => {
    const href = /<link[^>]+rel="icon"[^>]+href="([^"]+)"/.exec(shell)?.[1];
    expect(href).toBeDefined();
    expect(href).toMatch(/^\//);
    expect(
      existsSync(path.join(UI_ROOT, "public", (href as string).slice(1))),
    ).toBe(true);
  });
});
