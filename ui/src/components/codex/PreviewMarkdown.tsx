import { type ComponentProps, useContext, useMemo } from "react";
import Markdown, {
  type Components,
  defaultUrlTransform,
  type ExtraProps,
  type UrlTransform,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";
import { attachmentUrl, useAttachments } from "#/api/attachments";
import { CLink } from "#/components/codex/CLink";
import { PreviewContext } from "#/components/codex/PreviewContext";
import { MathExpression } from "#/components/MathExpression";
import { RenderedWikilink } from "#/components/RenderedWikilink";
import { expandPrefixedUrl } from "#/editor/prefixedExternalLinks";
import { useOpenTab } from "#/hooks/useOpenTab";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { classifyLinkResource } from "#/lib/linkResource";
import { type MathDelimiter, remarkFolioMath } from "#/lib/markdown/folioMath";
import { remarkWikilinks, wikilinkTarget } from "#/lib/markdown/wikilinks";
import { pagePreviewTarget } from "#/lib/previewTarget";
import {
  isCasResource,
  resolveResourceUrl,
  resolveVaultRelativeResource,
} from "#/lib/resourceUrl";

function isMathDelimiter(value: unknown): value is MathDelimiter {
  return value === "$" || value === "$$" || value === "\\(" || value === "\\[";
}

// Share the compact dialect with tab cards; only window content enables links.
const remarkPlugins: PluggableList = [
  remarkFolioMath,
  remarkGfm,
  ...remarkWikilinks,
];

// Compact element styling scaled for the ~340px preview card: tight headings,
// no top margin on the first block; code keeps mono via <pre>/<code>. Images are dropped to a
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
    <p className="my-1.5 text-[14px] leading-[1.55] text-ink-2 first:mt-0">
      {children}
    </p>
  ),
  h1: ({ children }) => (
    <h1 className="mt-3 mb-1 font-serif text-[19px] font-normal leading-tight text-ink first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-3 mb-1 font-serif text-[17px] font-normal leading-tight text-ink first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-2.5 mb-0.5 text-[14px] font-medium leading-snug text-ink first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-2.5 mb-0.5 text-[14px] font-medium leading-snug text-ink-2 first:mt-0">
      {children}
    </h4>
  ),
  ul: ({ children }) => (
    <ul className="my-1.5 ml-4 list-disc text-[14px] leading-[1.55] text-ink-2 marker:text-faint">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1.5 ml-4 list-decimal text-[14px] leading-[1.55] text-ink-2 marker:text-mute">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  a: PreviewLink,
  strong: ({ children }) => (
    <strong className="font-semibold text-ink">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="opacity-60">{children}</del>,
  code: ({ children }) => (
    <code className="rounded-[4px] bg-sink px-1 py-px text-[12.5px] text-ink">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-1.5 overflow-hidden whitespace-pre-wrap rounded-lg bg-sink px-3 py-2 text-[12.5px] leading-[1.55] text-ink-2 [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 font-serif text-[16px] italic leading-[1.4] text-ink">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-2 h-px border-0 bg-sink" />,
  table: ({ children }) => (
    <div className="my-1 overflow-x-auto">
      <table className="w-full border-collapse text-[13px] leading-[1.45]">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className="bg-sink px-2 py-1 text-left font-medium text-ink first:rounded-l-md last:rounded-r-md">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-2 py-1 align-top text-ink-2">{children}</td>
  ),
  img: ({ alt }) => (
    <span className="text-[12.5px] text-mute">🖼 {alt || "image"}</span>
  ),
};

function InteractivePreviewLink({
  href,
  children,
  node,
}: ComponentProps<"a"> & ExtraProps) {
  const openTab = useOpenTab();
  const rawTarget = wikilinkTarget(node);
  if (rawTarget !== null) {
    return (
      <RenderedWikilink
        target={rawTarget}
        onOpen={(path, label, target) => openTab("page", path, label, target)}
      >
        {children}
      </RenderedWikilink>
    );
  }
  const target = href ? pagePreviewTarget(href) : null;
  if (target)
    return (
      <CLink target={target} resource="wikilink">
        {children}
      </CLink>
    );
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`text-accent underline decoration-1 underline-offset-2 ${FOCUS_RING_NATIVE}`}
      data-link-resource={
        href ? (classifyLinkResource(href) ?? undefined) : undefined
      }
    >
      {children}
    </a>
  );
}

function PreviewLink(props: ComponentProps<"a"> & ExtraProps) {
  const parentId = useContext(PreviewContext);
  if (parentId) return <InteractivePreviewLink {...props} />;
  const resource =
    wikilinkTarget(props.node) !== null || props.href?.startsWith("/pages/")
      ? "wikilink"
      : props.href
        ? classifyLinkResource(props.href)
        : null;
  return (
    <span
      className="text-accent underline decoration-1 underline-offset-2"
      data-link-resource={resource ?? undefined}
    >
      {props.children}
    </span>
  );
}

const transformPreviewUrl: UrlTransform = (url) =>
  expandPrefixedUrl(url) ??
  (isCasResource(url) ? resolveResourceUrl(url) : defaultUrlTransform(url));

/**
 * Compact Markdown: interactive inside a preview window, inert in tab cards.
 * Render inside a height-clamped container; see PreviewBody.
 */
export function PreviewMarkdown({
  content,
  pagePath,
}: {
  content: string;
  pagePath?: string;
}) {
  const parentId = useContext(PreviewContext);
  return parentId ? (
    <InteractivePreviewMarkdown content={content} pagePath={pagePath} />
  ) : (
    <PreviewMarkdownBody content={content} pagePath={pagePath} />
  );
}

function InteractivePreviewMarkdown({
  content,
  pagePath,
}: {
  content: string;
  pagePath?: string;
}) {
  const inventory = useAttachments();
  const attachmentPaths = useMemo(
    () =>
      new Map(
        (inventory.data ?? []).map((item) => [
          item.vault_path,
          attachmentUrl(item.path),
        ]),
      ),
    [inventory.data],
  );
  return (
    <PreviewMarkdownBody
      content={content}
      pagePath={pagePath}
      attachmentPaths={attachmentPaths}
    />
  );
}

function PreviewMarkdownBody({
  content,
  pagePath,
  attachmentPaths,
}: {
  content: string;
  pagePath?: string;
  attachmentPaths?: ReadonlyMap<string, string>;
}) {
  return (
    <div className="folio-markdown-preview">
      <Markdown
        remarkPlugins={remarkPlugins}
        components={components}
        urlTransform={(url, key, node) => {
          const target = pagePath
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
              return `/pages/${encodeURIComponent(target.path)}${target.suffix}`;
            }
          }
          return transformPreviewUrl(url, key, node);
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
