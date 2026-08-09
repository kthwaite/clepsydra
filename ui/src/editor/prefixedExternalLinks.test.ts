import { describe, expect, it } from "vitest";
import { classifyLinkResource } from "#/lib/linkResource";
import { expandPrefixedLink } from "./prefixedExternalLinks";

describe("expandPrefixedLink", () => {
  it.each([
    ["wiki", "Vichy Catalán", "https://en.wikipedia.org/wiki/Vichy_Catal%C3%A1n", "Vichy Catalán"],
    ["WIKI", "  Vichy   Catalán  ", "https://en.wikipedia.org/wiki/Vichy_Catal%C3%A1n", "Vichy Catalán"],
    ["wiki", "Hypertext", "https://en.wikipedia.org/wiki/Hypertext", "Hypertext"],
  ])("expands Wikipedia value %#", (prefix, value, url, label) => {
    expect(expandPrefixedLink(prefix, value)).toEqual({
      provider: "wiki",
      url,
      label,
    });
  });

  it.each(["", "   ", "title\u0000suffix"])(
    "rejects invalid Wikipedia value %j",
    (value) => expect(expandPrefixedLink("wiki", value)).toBeNull(),
  );

  it.each([
    ["2401.00001", "2401.00001"],
    ["2401.00001V2", "2401.00001v2"],
    ["HEP-TH/9901001", "hep-th/9901001"],
    ["math.GT/0309136v2", "math.gt/0309136v2"],
  ])("normalizes arXiv identifier %s", (input, normalized) => {
    expect(expandPrefixedLink("arxiv", input)).toEqual({
      provider: "arxiv",
      url: `https://arxiv.org/abs/${normalized}`,
      label: `arXiv: ${normalized}`,
    });
  });

  it.each([
    "2401",
    "2401.123",
    "2401.123456",
    "2401.00001v0",
    "https://arxiv.org/abs/2401.00001",
    "hep-th/990101",
  ])("rejects malformed arXiv identifier %s", (input) => {
    expect(expandPrefixedLink("arxiv", input)).toBeNull();
  });

  it.each([
    ["dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ"],
    ["https://youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ])("normalizes YouTube value %s", (input, id) => {
    expect(expandPrefixedLink("YOUTUBE", input)).toEqual({
      provider: "youtube",
      url: `https://www.youtube.com/watch?v=${id}`,
      label: `YouTube: ${id}`,
    });
  });

  it.each([
    "short",
    "https://youtube.com/playlist?list=PL123",
    "https://youtube.com.example.test/watch?v=dQw4w9WgXcQ",
    "https://example.test/watch?v=dQw4w9WgXcQ",
    "ftp://youtube.com/watch?v=dQw4w9WgXcQ",
  ])("rejects invalid YouTube value %s", (input) => {
    expect(expandPrefixedLink("youtube", input)).toBeNull();
  });

  it("returns null for unknown prefixes and never throws on malformed input", () => {
    expect(expandPrefixedLink("doi", "10.1000/example")).toBeNull();
    expect(() => expandPrefixedLink("youtube", "https://%")).not.toThrow();
    expect(expandPrefixedLink("youtube", "https://%")).toBeNull();
  });

  it.each([
    ["wiki", "Hypertext", "wikipedia"],
    ["arxiv", "2401.00001", "arxiv"],
    ["youtube", "dQw4w9WgXcQ", "youtube"],
  ])("generates a URL classified as %s", (prefix, value, resource) => {
    const expanded = expandPrefixedLink(prefix, value);
    expect(expanded).not.toBeNull();
    expect(classifyLinkResource(expanded?.url ?? "")).toBe(resource);
  });
});
