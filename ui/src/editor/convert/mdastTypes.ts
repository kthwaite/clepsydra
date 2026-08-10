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
