/** Extended mdast node produced/consumed by the wikilink plugin. Not in standard mdast typings. */
export interface WikiLinkMdast {
  type: "wikiLink";
  data: {
    alias?: string;
    permalink: string;
  };
}
