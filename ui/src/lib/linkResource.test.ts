import { describe, expect, it } from "vitest";
import { classifyLinkResource } from "#/lib/linkResource";

describe("classifyLinkResource", () => {
  it.each([
    ["https://en.wikipedia.org/wiki/Hypertext", "wikipedia"],
    ["https://commons.wikimedia.org/wiki/File:Example.svg", "wikipedia"],
    ["https://foundation.wikimedia.org/wiki/Policy", "wikipedia"],
    ["https://en.wiktionary.org/wiki/link", "wikipedia"],
    ["https://arxiv.org/pdf/2401.00001.pdf", "arxiv"],
    ["https://www.biorxiv.org/content/10.1101/2025.01.01.000001", "biorxiv"],
    ["https://www.medrxiv.org/content/10.1101/2025.01.01.000001", "biorxiv"],
    ["https://doi.org/10.1000/example", "doi"],
    ["https://pubmed.ncbi.nlm.nih.gov/12345678/", "pubmed"],
    ["https://pmc.ncbi.nlm.nih.gov/articles/PMC123/", "pubmed"],
    ["https://www.semanticscholar.org/paper/example", "semantic-scholar"],
    ["https://github.com/example/project", "github"],
    [
      "https://raw.githubusercontent.com/example/project/main/file.ts",
      "github",
    ],
    ["https://gitlab.com/example/project", "gitlab"],
    [
      "https://web.archive.org/web/20200101/https://example.com",
      "internet-archive",
    ],
    ["https://www.youtube.com/watch?v=abc", "youtube"],
    ["https://youtu.be/abc", "youtube"],
    ["https://player.vimeo.com/video/123", "vimeo"],
    ["https://example.com/paper.PDF?download=1#page=2", "pdf"],
    ["https://example.com/audio.flac", "audio"],
    ["https://example.com/movie.webm", "video"],
    ["https://example.com/figure.avif", "image"],
  ])("classifies %s as %s", (href, expected) => {
    expect(classifyLinkResource(href)).toBe(expected);
  });

  it.each([
    "notes/local.md",
    "/pages/notes/local.md",
    "#section",
    "mailto:person@example.com",
    "clepsydra://page/123",
    "javascript:alert(1)",
    "not a url",
    "https://example.com/page",
    "https://wikipedia.org.example.com/wiki/Fake",
    "https://github.com.example.com/project",
    "https://ncbi.nlm.nih.gov/",
    "https://example.com/file.pdf.exe",
  ])("does not classify %s", (href) => {
    expect(classifyLinkResource(href)).toBeNull();
  });

  it("normalizes protocol and hostname case", () => {
    expect(classifyLinkResource("HTTPS://EN.WIKIPEDIA.ORG/wiki/Test")).toBe(
      "wikipedia",
    );
  });

  it("gives service identity precedence over file type", () => {
    expect(classifyLinkResource("https://github.com/example/paper.pdf")).toBe(
      "github",
    );
  });
});
