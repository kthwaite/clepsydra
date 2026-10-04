import { type ReactNode, useRef } from "react";
import Markdown, {
  type Components,
  defaultUrlTransform,
  type UrlTransform,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";
import { BlockTransclusion } from "#/components/blocks/BlockTransclusion";
import { MathExpression } from "#/components/MathExpression";
import { MermaidCodeBlock } from "#/components/MermaidCodeBlock";
import { RenderedWikilink } from "#/components/RenderedWikilink";
import { CopyButton } from "#/components/ui/CopyButton";
import { expandPrefixedUrl } from "#/editor/prefixedExternalLinks";
import { useOpenTab } from "#/hooks/useOpenTab";
import { classifyLinkResource } from "#/lib/linkResource";
import {
  BLOCK_REFERENCE_SCHEME,
  blockIdFromHref,
  remarkBlockReferences,
} from "#/lib/markdown/blockReferences";
import { type MathDelimiter, remarkFolioMath } from "#/lib/markdown/folioMath";
import { mermaidFenceSource } from "#/lib/markdown/mermaidFence";
import { remarkWikilinks, wikilinkTarget } from "#/lib/markdown/wikilinks";
import {
  isCasResource,
  resolveResourceUrl,
  resolveVaultRelativeResource,
} from "#/lib/resourceUrl";
import type { OpenTabTarget } from "#/store/workspace";

interface MarkdownRendererProps {
  content: string;
  /** Render stored/template Markdown without executing transclusions or diagrams. */
  restricted?: boolean;
  pagePath?: string;
  attachmentPaths?: ReadonlyMap<string, string>;
  /**
   * Compact styling for small surfaces such as a task card: headings at body
   * size, images hidden, plain code blocks.
   */
  compact?: boolean;
  /**
   * Opens a linked page. Replaces the default workspace tab opening, so the
   * renderer then needs no router. Unresolved wikilinks render as plain links
   * (there is no resolution provider to tell them apart).
   */
  onOpenPage?: (path: string) => void;
}

type OpenPage = (path: string, label?: string, target?: OpenTabTarget) => void;

function isMathDelimiter(value: unknown): value is MathDelimiter {
  return value === "$" || value === "$$" || value === "\\(" || value === "\\[";
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
        className="overflow-x-auto rounded-[12px] bg-sink p-4 text-[13px] leading-[1.6] text-ink"
      >
        {children}
      </pre>
      <CopyButton
        getText={() => ref.current?.textContent ?? ""}
        label="Copy code"
        className="absolute right-3 top-3 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
      />
    </div>
  );
}

const remarkPlugins: PluggableList = [
  remarkFolioMath,
  remarkGfm,
  remarkBlockReferences,
  ...remarkWikilinks,
];

const transformMarkdownUrl: UrlTransform = (url, key, node) => {
  if (
    key === "href" &&
    node.tagName === "a" &&
    url.startsWith(BLOCK_REFERENCE_SCHEME)
  ) {
    return url;
  }
  const expanded = expandPrefixedUrl(url);
  if (expanded) return expanded;
  return isCasResource(url)
    ? resolveResourceUrl(url)
    : defaultUrlTransform(url);
};

// Compact element overrides: body-size headings, no images, plain blocks.
const compactComponents: Components = {
  h1: CompactHeading,
  h2: CompactHeading,
  h3: CompactHeading,
  h4: CompactHeading,
  h5: CompactHeading,
  h6: CompactHeading,
  img: () => null,
  p: ({ children }) => <p className="my-1 first:mt-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1 ml-4 list-disc">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 ml-4 list-decimal">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="my-1 italic">{children}</blockquote>
  ),
  pre: ({ children }) => (
    <pre className="my-1 whitespace-pre-wrap rounded-[6px] bg-sink px-2 py-1 [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
};

function CompactHeading({ children }: { children?: ReactNode }) {
  return <p className="my-1 font-medium text-ink-2 first:mt-0">{children}</p>;
}

export function MarkdownRenderer({
  onOpenPage,
  ...props
}: MarkdownRendererProps) {
  if (onOpenPage) {
    return <MarkdownBody {...props} openPage={(path) => onOpenPage(path)} />;
  }
  return <RoutedMarkdownRenderer {...props} />;
}

function RoutedMarkdownRenderer(props: BaseProps) {
  const openTab = useOpenTab();
  return (
    <MarkdownBody
      {...props}
      openPage={(...args) => openTab("page", ...args)}
      markDangling
    />
  );
}

type BaseProps = Omit<MarkdownRendererProps, "onOpenPage">;

type MarkdownBodyProps = BaseProps & {
  openPage: OpenPage;
  markDangling?: boolean;
};

function MarkdownBody({
  content,
  restricted = false,
  pagePath,
  attachmentPaths,
  compact = false,
  openPage,
  markDangling = false,
}: MarkdownBodyProps) {
  return (
    <Markdown
      remarkPlugins={remarkPlugins}
      skipHtml={restricted}
      urlTransform={(url, key, node) => {
        const target =
          restricted && pagePath
            ? resolveVaultRelativeResource(url, pagePath)
            : null;
        if (target) {
          const attachment = attachmentPaths?.get(target.path);
          if (attachment) return attachment + target.suffix;
          if (
            key === "href" &&
            node.tagName === "a" &&
            /\.md$/i.test(target.path)
          ) {
            return `/pages/${encodeURIComponent(target.path)}`;
          }
        }
        return transformMarkdownUrl(url, key, node);
      }}
      components={{
        span: ({ children, node, ...props }) => {
          const tex = node?.properties["data-tex"];
          const delimiter = node?.properties["data-delimiter"];
          if (
            node?.properties["data-folio-math"] === true &&
            typeof tex === "string" &&
            isMathDelimiter(delimiter)
          ) {
            return (
              <MathExpression tex={tex} delimiter={delimiter} display={false} />
            );
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
        a: ({ href, children, node, ...props }) => {
          const target = wikilinkTarget(node);
          if (target !== null) {
            return (
              <RenderedWikilink
                target={target}
                onOpen={openPage}
                markDangling={markDangling}
              >
                {children}
              </RenderedWikilink>
            );
          }
          const blockId = href ? blockIdFromHref(href) : null;
          if (blockId && !restricted) {
            return (
              <BlockTransclusion
                blockId={blockId}
                onOpenSource={(block) => {
                  openPage(
                    block.page_path,
                    block.page_title || block.page_path,
                    {
                      blockId,
                    },
                  );
                }}
              />
            );
          }
          if (href?.startsWith(BLOCK_REFERENCE_SCHEME)) return children;

          const resource = href ? classifyLinkResource(href) : null;
          if (href?.startsWith("/pages/")) {
            const pagePath = decodeURIComponent(href.replace(/^\/pages\//, ""));
            return (
              <a
                {...props}
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  openPage(pagePath);
                }}
                className="underline decoration-1 underline-offset-2 hover:decoration-2"
                data-link-resource="wikilink"
              >
                {children}
              </a>
            );
          }
          return (
            <a
              {...props}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-1 underline-offset-2 hover:decoration-2"
              data-link-resource={resource ?? undefined}
            >
              {children}
            </a>
          );
        },
        table: ({ children, ...props }) => (
          // Tone and space, not rules (spec decision 5): a raised panel with
          // the header row on sink and no cell borders — as the Folio table.
          <table
            className="w-full border-separate border-spacing-0 rounded-[14px] bg-raise text-[0.9em] leading-[1.5]"
            {...props}
          >
            {children}
          </table>
        ),
        th: ({ children, ...props }) => (
          <th
            className="bg-sink px-4 py-2.5 text-left align-bottom text-[13px] font-normal text-mute first:rounded-tl-[14px] last:rounded-tr-[14px]"
            {...props}
          >
            {children}
          </th>
        ),
        td: ({ children, ...props }) => (
          <td className="px-4 py-2.5 align-top text-ink-2" {...props}>
            {children}
          </td>
        ),
        pre: ({ children, node }) => {
          const mermaid = mermaidFenceSource(node);
          if (mermaid !== null && !restricted)
            return <MermaidCodeBlock code={mermaid} />;
          return <MarkdownCodeBlock>{children}</MarkdownCodeBlock>;
        },
        code: ({ children, className: codeClassName, ...props }) => {
          if (codeClassName) {
            return (
              <code className={codeClassName} {...props}>
                {children}
              </code>
            );
          }
          return (
            <code
              className="rounded-[6px] bg-sink px-1 py-0.5 text-[0.88em]"
              {...props}
            >
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
          <h3 className="mb-2 mt-4 text-lg font-semibold" {...props}>
            {children}
          </h3>
        ),
        blockquote: ({ children, ...props }) => (
          <blockquote
            className="my-4 pl-5 font-serif text-[1.2em] italic leading-[1.4] text-ink-2"
            {...props}
          >
            {children}
          </blockquote>
        ),
        ...(compact ? compactComponents : {}),
      }}
    >
      {content}
    </Markdown>
  );
}
