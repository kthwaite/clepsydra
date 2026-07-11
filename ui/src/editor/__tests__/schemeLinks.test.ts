import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSchemeUrl } from "#/api/deeplink";
import { isSchemeLink, openSchemeLink } from "#/editor/schemeLinks";

describe("isSchemeLink", () => {
  it("matches clepsydra:// and obsidian:// case-insensitively", () => {
    expect(isSchemeLink("clepsydra://page/x")).toBe(true);
    expect(isSchemeLink("OBSIDIAN://open?vault=v&file=f")).toBe(true);
  });

  it("does not match http, mailto, or vault paths", () => {
    expect(isSchemeLink("https://example.com")).toBe(false);
    expect(isSchemeLink("mailto:kit@example.com")).toBe(false);
    expect(isSchemeLink("projects/note.md")).toBe(false);
  });
});

describe("openSchemeLink", () => {
  it("opens a page tab when the target resolves", async () => {
    const openTab = vi.fn();
    const notify = vi.fn();
    await openSchemeLink("clepsydra://page/x", {
      resolve: async () => "projects/x.md",
      openTab,
      notify,
    });
    expect(openTab).toHaveBeenCalledWith("page", "projects/x.md");
    expect(notify).not.toHaveBeenCalled();
  });

  it("notifies on a miss without opening a tab", async () => {
    const openTab = vi.fn();
    const notify = vi.fn();
    await openSchemeLink("clepsydra://page/nope", {
      resolve: async () => null,
      openTab,
      notify,
    });
    expect(openTab).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("No page matches clepsydra://page/nope");
  });

  it("notifies when resolution throws", async () => {
    const notify = vi.fn();
    await openSchemeLink("clepsydra://page/x", {
      resolve: async () => {
        throw new Error("network down");
      },
      openTab: vi.fn(),
      notify,
    });
    expect(notify).toHaveBeenCalledWith("Could not resolve clepsydra://page/x");
  });
});

describe("resolveSchemeUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the path on 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ path: "a/b.md" }), { status: 200 })),
    );
    await expect(resolveSchemeUrl("clepsydra://page/b")).resolves.toBe("a/b.md");
    expect(fetch).toHaveBeenCalledWith(
      `/api/vault/resolve?url=${encodeURIComponent("clepsydra://page/b")}`,
    );
  });

  it("returns null on 404 and throws on 500", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    await expect(resolveSchemeUrl("clepsydra://page/nope")).resolves.toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    await expect(resolveSchemeUrl("clepsydra://page/x")).rejects.toThrow();
  });
});
