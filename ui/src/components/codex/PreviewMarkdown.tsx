import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import wikiLinkPlugin from "remark-wiki-link";
import type { PluggableList } from "unified";
import { MathExpression } from "#/components/MathExpression";
import { classifyLinkResource } from "#/lib/linkResource";
import { type MathDelimiter, remarkFolioMath } from "#/lib/markdown/folioMath";

function isMathDelimiter(value: unknown): value is MathDelimiter {
  return value === "$" || value === "$$" || value === "\\(" || value === "\\[";
}

// Shared remark config with the full-page MarkdownRenderer, minus the
// interactive link handling — preview cards are pointer-events:none, so links
// render as plain styled spans and we avoid pulling in router hooks.
const remarkPlugins: PluggableList = [
  remarkFolioMath,
  remarkGfm,
  [
    wikiLinkPlugin,
    {
      hrefTemplate: (permalink: string) => `/pages/${permalink}`,
      aliasDivider: "|",
    },
  ],
];

// Compact element styling scaled for the ~340px preview card: tight headings,
// no top margin on the first block, small mono code. Images are dropped to a
// label — a hover preview should not trigger network loads.
const components: Components = {
  span: ({ children, node, ...props }) => {
    const tex = node?.properties["data-tex"];
    const delimiter = node?.properties["data-delimiter"];
    if (
      node?.properties["data-folio-math"] === true &&
      typeof tex === "string" &&
      isMathDelimiter(delimiter)
    ) {
      return <MathExpression tex={tex} delimiter={delimiter} display={false} />;
    }
    return <span {...props}>{children}</span>;
  },
  div: ({ children, node, ...props }) => {
    const tex = node?.properties["data-tex"];
    const delimiter = node?.properties["data-delimiter"];
    if (
      node?.properties["data-folio-math"] === true &&
      typeof tex === "string" &&
      isMathDelimiter(delimiter)
    ) {
      return <MathExpression tex={tex} delimiter={delimiter} display />;
    }
    return <div {...props}>{children}</div>;
  },
  p: ({ children }) => (
    <p className="my-1 font-sans text-[11.5px] leading-[1.5] text-ink-mute first:mt-0">
      {children}
    </p>
  ),
  h1: ({ children }) => (
    <h1 className="mt-2 mb-1 font-sans text-[13px] font-bold leading-tight text-ink first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-2 mb-1 font-sans text-[12px] font-bold leading-tight text-ink first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="cl-mono mt-2 mb-[2px] text-[9px] font-bold uppercase tracking-[0.1em] text-ink-mute first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="cl-mono mt-2 mb-[2px] text-[9px] font-bold uppercase tracking-[0.1em] text-ink-mute first:mt-0">
      {children}
    </h4>
  ),
  ul: ({ children }) => (
    <ul className="my-1 ml-3 list-disc font-sans text-[11.5px] leading-[1.5] text-ink-mute marker:text-ink-faint">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1 ml-3 list-decimal font-sans text-[11.5px] leading-[1.5] text-ink-mute marker:text-ink-faint">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="my-[1px]">{children}</li>,
  a: ({ href, children }) => {
    const resource = href ? classifyLinkResource(href) : null;
    return (
      <span
        className="text-accent underline decoration-1 underline-offset-2"
        data-link-resource={resource ?? undefined}
      >
        {children}
      </span>
    );
  },
  strong: ({ children }) => (
    <strong className="font-bold text-ink">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="opacity-60">{children}</del>,
  code: ({ children }) => (
    <code className="cl-mono bg-paper-2 px-[3px] py-[1px] text-[10.5px] text-ink">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="cl-mono my-1 overflow-hidden whitespace-pre-wrap border border-rule-soft bg-paper-2 p-[6px] text-[10px] leading-[1.4] text-ink-mute">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-rule pl-2 font-sans text-[11.5px] italic leading-[1.5] text-ink-faint">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-1.5 border-0 border-t border-rule-soft" />,
  table: ({ children }) => (
    <div className="my-1 overflow-x-auto">
      <table className="w-full border-collapse border border-rule-soft font-sans text-[10.5px] leading-[1.4]">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-rule-soft bg-paper-2 px-1.5 py-[2px] text-left font-bold text-ink">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-rule-soft px-1.5 py-[2px] align-top text-ink-mute">
      {children}
    </td>
  ),
  img: ({ alt }) => (
    <span className="cl-mono text-[9px] text-ink-faint">
      🖼 {alt || "image"}
    </span>
  ),
};

/**
 * Compact, non-interactive markdown renderer for the preview card. Render inside
 * a height-clamped container; see PreviewBody.
 */
export function PreviewMarkdown({ content }: { content: string }) {
  return (
    <div className="folio-markdown-preview">
      <Markdown remarkPlugins={remarkPlugins} components={components}>
        {content}
      </Markdown>
    </div>
  );
}
