import { useNavigate } from "@tanstack/react-router";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import wikiLinkPlugin from "remark-wiki-link";
import type { PluggableList } from "unified";

interface MarkdownRendererProps {
  content: string;
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
  const navigate = useNavigate();

  return (
    <Markdown
      remarkPlugins={remarkPlugins}
      components={{
        a: ({ href, children, ...props }) => {
          if (href?.startsWith("/pages/")) {
            return (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  navigate({ to: href });
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
        pre: ({ children, ...props }) => (
          <pre
            className="overflow-x-auto border border-border bg-muted p-4 text-sm"
            {...props}
          >
            {children}
          </pre>
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
            <code className="bg-muted px-1 py-0.5 text-sm" {...props}>
              {children}
            </code>
          );
        },
        h1: ({ children, ...props }) => (
          <h1 className="mb-4 mt-8 text-2xl font-bold" {...props}>
            {children}
          </h1>
        ),
        h2: ({ children, ...props }) => (
          <h2 className="mb-3 mt-6 text-xl font-bold" {...props}>
            {children}
          </h2>
        ),
        h3: ({ children, ...props }) => (
          <h3 className="mb-2 mt-4 text-lg font-bold" {...props}>
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
