import GithubSlugger from "github-slugger";
import type { Root } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";

export interface DocTocEntry {
  depth: number;
  text: string;
  id: string;
}

const mdxParser = unified().use(remarkParse).use(remarkGfm).use(remarkMdx);

/**
 * Per-document heading outline for the "On this page" rail.
 *
 * The walk mirrors `buildDocsIndex` in `#/docs/search` exactly — same parser,
 * top-level nodes only, same indented-code guard, same slugger input — so the
 * ids match the ones `rehype-slug` puts on the compiled headings. The
 * agreement is pinned by the DOM test in `toc.test.tsx`.
 */
export function extractDocToc(source: string): readonly DocTocEntry[] {
  const slugger = new GithubSlugger();
  const entries: DocTocEntry[] = [];
  const tree = mdxParser.parse(source) as Root;

  for (const node of tree.children) {
    // MDX parses CommonMark-indented code as a paragraph at its source column.
    if ((node.position?.start.column ?? 1) > 4) {
      continue;
    }

    if (node.type !== "heading" || node.depth === 1) {
      continue;
    }

    const semanticHeading = mdastToString(node, {
      includeHtml: false,
      includeImageAlt: false,
    });

    entries.push({
      depth: node.depth,
      text: semanticHeading.replace(/\s+/g, " ").trim(),
      id: slugger.slug(semanticHeading),
    });
  }

  return entries;
}
