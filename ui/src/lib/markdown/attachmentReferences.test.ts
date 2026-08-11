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
});
