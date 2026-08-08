import { type ReactNode, useRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import wikiLinkPlugin from "remark-wiki-link";
import type { PluggableList } from "unified";
import { CopyButton } from "#/components/ui/CopyButton";
import { useOpenTab } from "#/hooks/useOpenTab";
import { classifyLinkResource } from "#/lib/linkResource";

interface MarkdownRendererProps {
  content: string;
}

/**
 * A fenced code block with a hover-reveal copy button. The button reads the
 * rendered text straight off the <pre>, so it copies exactly what's shown
 * regardless of inline markup.
 */
function MarkdownCodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="group relative">
      <pre
        ref={ref}
        className="overflow-x-auto border border-border bg-muted p-4 font-mono text-sm"
      >
        {children}
      </pre>
      <CopyButton
        getText={() => ref.current?.textContent ?? ""}
        label="Copy code"
        className="absolute right-2 top-2 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
      />
    </div>
  );
}

const remarkPlugins: PluggableList = [
  remarkGfm,
  [
    wikiLinkPlugin,
    {
      hrefTemplate: (permalink: string) => `/pages/${permalink}`,
      aliasDivider: "|",
    },
  ],
];

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const openTab = useOpenTab();

  return (
    <Markdown
      remarkPlugins={remarkPlugins}
      components={{
        a: ({ href, children, ...props }) => {
          const resource = href ? classifyLinkResource(href) : null;
          if (href?.startsWith("/pages/")) {
            const pagePath = decodeURIComponent(href.replace(/^\/pages\//, ""));
            return (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  openTab("page", pagePath);
                }}
                className="underline decoration-1 underline-offset-2 hover:decoration-2"
                {...props}
              >
                {children}
              </a>
            );
          }
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-1 underline-offset-2 hover:decoration-2"
              data-link-resource={resource ?? undefined}
              {...props}
            >
              {children}
            </a>
          );
        },
        table: ({ children, ...props }) => (
          <table
            className="w-full border-collapse border border-border"
            {...props}
          >
            {children}
          </table>
        ),
        th: ({ children, ...props }) => (
          <th
            className="border border-border bg-muted px-3 py-1.5 text-left text-sm font-bold"
            {...props}
          >
            {children}
          </th>
        ),
        td: ({ children, ...props }) => (
          <td className="border border-border px-3 py-1.5 text-sm" {...props}>
            {children}
          </td>
        ),
        pre: ({ children }) => (
          <MarkdownCodeBlock>{children}</MarkdownCodeBlock>
        ),
        code: ({ children, className: codeClassName, ...props }) => {
          if (codeClassName) {
            return (
              <code className={codeClassName} {...props}>
                {children}
              </code>
            );
          }
          return (
            <code className="bg-muted px-1 py-0.5 font-mono text-sm" {...props}>
              {children}
            </code>
          );
        },
        h1: ({ children, ...props }) => (
          <h1 className="mb-4 mt-8 font-heading text-2xl font-bold" {...props}>
            {children}
          </h1>
        ),
        h2: ({ children, ...props }) => (
          <h2 className="mb-3 mt-6 font-heading text-xl font-bold" {...props}>
            {children}
          </h2>
        ),
        h3: ({ children, ...props }) => (
          <h3
            className="mb-2 mt-4 font-heading text-lg font-semibold"
            {...props}
          >
            {children}
          </h3>
        ),
        blockquote: ({ children, ...props }) => (
          <blockquote
            className="border-l-4 border-border pl-4 italic text-muted-foreground"
            {...props}
          >
            {children}
          </blockquote>
        ),
      }}
    >
      {content}
    </Markdown>
  );
}
