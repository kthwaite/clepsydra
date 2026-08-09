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
});
