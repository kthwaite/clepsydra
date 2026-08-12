import { describe, expect, it } from "vitest";
import { attachmentReferences } from "./attachmentReferences";

describe("attachmentReferences", () => {
  it("returns unique vault attachment references in source order", () => {
    expect(
      attachmentReferences(
        [
          "![Chart](/api/vault/attachments/research/chart%201.png)",
          "[Paper](/api/vault/attachments/paper.pdf)",
          "![Again](/api/vault/attachments/research/chart%201.png)",
          "[External](https://example.com/file.pdf)",
        ].join("\n"),
      ),
    ).toEqual([
      { path: "research/chart 1.png", label: "Chart", image: true },
      { path: "paper.pdf", label: "Paper", image: false },
    ]);
  });

  it("uses rendered labels from escaped and nested Markdown", () => {
    expect(
      attachmentReferences(
        [
          String.raw`[A \[draft\] *paper*](/api/vault/attachments/papers/a.pdf)`,
          String.raw`![Plot \[final\]](/api/vault/attachments/plots/final.png)`,
        ].join("\n"),
      ),
    ).toEqual([
      { path: "papers/a.pdf", label: "A [draft] paper", image: false },
      { path: "plots/final.png", label: "Plot [final]", image: true },
    ]);
  });

  it("decodes attachment paths without throwing on malformed URLs", () => {
    expect(
      attachmentReferences(
        [
          "[Résumé](/api/vault/attachments/caf%C3%A9/r%C3%A9sum%C3%A9%20final.pdf)",
          "[Encoded prefix](%2Fapi%2Fvault%2Fattachments%2Fnested%2Fscan.pdf)",
          "[Malformed](/api/vault/attachments/bad%2)",
        ].join("\n"),
      ),
    ).toEqual([
      {
        path: "café/résumé final.pdf",
        label: "Résumé",
        image: false,
      },
      {
        path: "nested/scan.pdf",
        label: "Encoded prefix",
        image: false,
      },
    ]);
  });

  it("excludes non-attachment and empty attachment URLs", () => {
    expect(
      attachmentReferences(
        [
          "[Relative](paper.pdf)",
          "[External](https://example.com/api/vault/attachments/paper.pdf)",
          "[Lookalike](/api/vault/attachmentship/paper.pdf)",
          "[Empty](/api/vault/attachments/)",
          "`[Code](/api/vault/attachments/code.pdf)`",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
  it("resolves reference-style links and images at occurrence order", () => {
    expect(
      attachmentReferences(
        [
          "[First paper][paper]",
          "![Plot][plot]",
          "[Repeated paper][paper]",
          "[Manual][]",
          "[Appendix]",
          "[Unresolved][missing]",
          "",
          "[plot]: /api/vault/attachments/plots/result%201.png",
          "[paper]: /api/vault/attachments/papers/main.pdf",
          "[manual]: /api/vault/attachments/manual.pdf",
          "[appendix]: /api/vault/attachments/appendix.pdf",
        ].join("\n"),
      ),
    ).toEqual([
      { path: "papers/main.pdf", label: "First paper", image: false },
      { path: "plots/result 1.png", label: "Plot", image: true },
      { path: "manual.pdf", label: "Manual", image: false },
      { path: "appendix.pdf", label: "Appendix", image: false },
    ]);
  });

  it("strips literal URI suffixes before decoding reserved filename characters", () => {
    expect(
      attachmentReferences(
        [
          "[First](/api/vault/attachments/%70aper.pdf?download=1#page-2)",
          "[Equivalent](/api/vault/attachments/paper.pdf)",
          "[Question](/api/vault/attachments/name%3F.pdf?download=1)",
          "[Hash](/api/vault/attachments/name%23draft.pdf#preview)",
          "[Percent](/api/vault/attachments/100%25.pdf)",
        ].join("\n"),
      ),
    ).toEqual([
      { path: "paper.pdf", label: "First", image: false },
      { path: "name?.pdf", label: "Question", image: false },
      { path: "name#draft.pdf", label: "Hash", image: false },
      { path: "100%.pdf", label: "Percent", image: false },
    ]);
  });

  it("normalizes equivalent Unicode paths and ignores HTML and fenced code", () => {
    const decomposedCafe = "cafe\u0301";
    expect(
      attachmentReferences(
        [
          `[First](/api/vault/attachments/${encodeURIComponent(decomposedCafe)}.pdf)`,
          "[Equivalent](/api/vault/attachments/caf%C3%A9.pdf)",
          '<a href="/api/vault/attachments/raw.html">Raw HTML</a>',
          "```md",
          "[Fenced](/api/vault/attachments/fenced.pdf)",
          "```",
        ].join("\n"),
      ),
    ).toEqual([{ path: "café.pdf", label: "First", image: false }]);
  });
});
