import type { InlineMath, Math } from "mdast-util-math";
import type { FolioMathData } from "#/lib/markdown/folioMath";

export type FolioInlineMathMdast = Omit<InlineMath, "data"> & {
  data: FolioMathData & { folioDelimiter: "$" | "\\(" };
};

export type FolioMathMdast = Omit<Math, "data"> & {
  data: FolioMathData & { folioDelimiter: "$$" | "\\[" };
};

/** Extended mdast node produced/consumed by the wikilink plugin. Not in standard mdast typings. */
export interface WikiLinkMdast {
  type: "wikiLink";
  data: {
    alias?: string;
    permalink: string;
  };
}

/** Raw fenced Base block written verbatim by the Base Markdown handler. */
export interface BaseFenceMdast {
  type: "baseFence";
  rawBlock: string;
}
