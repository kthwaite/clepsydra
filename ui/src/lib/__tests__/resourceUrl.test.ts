import { describe, expect, it } from "vitest";
import { resolveLinkTarget, resolveResourceUrl } from "../resourceUrl";

describe("resource URL resolution", () => {
  it("rewrites CAS resources to the vault blob endpoint", () => {
    expect(resolveResourceUrl("cas:sha256:abc123")).toBe(
      "/api/vault/cas/sha256:abc123",
    );
    expect(resolveLinkTarget("cas:sha256:abc123")).toEqual({
      kind: "browser",
      href: "/api/vault/cas/sha256:abc123",
    });
  });

  it("leaves ordinary external resources unchanged", () => {
    expect(resolveResourceUrl("https://example.com/image.png")).toBe(
      "https://example.com/image.png",
    );
    expect(resolveLinkTarget("mailto:reader@example.com")).toEqual({
      kind: "browser",
      href: "mailto:reader@example.com",
    });
  });

  it("keeps vault page paths as internal navigation targets", () => {
    expect(resolveLinkTarget("notes/project.md")).toEqual({
      kind: "vault",
      path: "notes/project.md",
    });
  });

  it("opens prefixed external links in the browser, not as vault pages", () => {
    expect(resolveLinkTarget("arxiv:2301.00001")).toEqual({
      kind: "browser",
      href: "https://arxiv.org/abs/2301.00001",
    });
    expect(resolveLinkTarget("wiki:Hysteresis")).toEqual({
      kind: "browser",
      href: "https://en.wikipedia.org/wiki/Hysteresis",
    });
  });
});
