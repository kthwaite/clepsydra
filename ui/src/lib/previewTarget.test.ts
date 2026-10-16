import { describe, expect, it } from "vitest";
import {
  pagePreviewTarget,
  previewOpenTarget,
  previewTargetHref,
  previewTargetKey,
  wikilinkPreviewTarget,
} from "#/lib/previewTarget";

describe("preview passage targets", () => {
  it("retains the heading after resolving a wikilink's page name", () => {
    const target = wikilinkPreviewTarget(
      "people/Jane Doe.md",
      "Jane Doe#Early life",
    );
    expect(target).toEqual({
      path: "people/Jane Doe.md",
      heading: "Early life",
    });
    expect(previewOpenTarget(target)).toEqual({ heading: "Early life" });
    expect(previewTargetKey(target)).not.toBe(
      previewTargetKey({ ...target, heading: "Later life" }),
    );
    expect(previewTargetKey(target)).not.toBe(
      previewTargetKey({ path: target.path }),
    );
  });

  it("separates fragments before decoding filename hashes and round-trips Unicode", () => {
    const target = { path: "notes/Café #1%.md", heading: "研究 & café" };
    expect(
      pagePreviewTarget(
        "/pages/notes%2FCaf%C3%A9%20%231%25.md#%E7%A0%94%E7%A9%B6%20%26%20caf%C3%A9",
      ),
    ).toEqual(target);
    expect(pagePreviewTarget(previewTargetHref(target))).toEqual(target);
    expect(pagePreviewTarget("/pages/notes%2Fa%23b.md")).toEqual({
      path: "notes/a#b.md",
    });
  });

  it("carries block destinations through page hrefs and navigation", () => {
    const target = { path: "source.md", blockId: "abc123DEF0" };
    expect(pagePreviewTarget(previewTargetHref(target))).toEqual(target);
    expect(previewOpenTarget(target)).toEqual({ blockId: "abc123DEF0" });
    expect(previewTargetKey(target)).not.toBe(
      previewTargetKey({ path: target.path, heading: target.blockId }),
    );
    expect(pagePreviewTarget("https://example.com/pages/source.md")).toBeNull();
    expect(pagePreviewTarget("/pages/%not-encoded")).toBeNull();
  });
});
