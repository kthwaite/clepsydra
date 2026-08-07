import { Link } from "@tanstack/react-router";
import {
  type AnchorHTMLAttributes,
  type ComponentPropsWithoutRef,
  type HTMLAttributes,
  useRef,
} from "react";
import type { MDXComponents } from "mdx/types";
import { CopyButton } from "#/components/ui/CopyButton";
import { cn } from "#/lib/cn";

const linkClasses =
  "font-medium text-ink underline decoration-rule underline-offset-4 transition-colors hover:text-accent hover:decoration-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const headingClasses = {
  h2: "mt-10 text-2xl font-bold tracking-tight text-ink",
  h3: "mt-8 text-xl font-semibold tracking-tight text-ink",
  h4: "mt-7 text-lg font-semibold text-ink",
  h5: "mt-6 text-base font-semibold text-ink",
  h6: "mt-6 text-sm font-bold uppercase tracking-wide text-ink",
} as const;

type HeadingTag = keyof typeof headingClasses;

function createHeading(Tag: HeadingTag) {
  return function DocsHeading({
    id,
    children,
    className,
    ...props
  }: HTMLAttributes<HTMLHeadingElement>) {
    return (
      <Tag
        {...props}
        id={id}
        className={cn(
          "group scroll-mt-6 font-sans leading-tight first:mt-0",
          headingClasses[Tag],
          className,
        )}
      >
        {children}
        {id ? (
          <a
            href={`#${id}`}
            aria-label={`Link to ${id.replaceAll("-", " ")} section`}
            className="ml-2 text-ink-mute opacity-0 transition-opacity hover:text-accent focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring group-hover:opacity-100"
          >
            #
          </a>
        ) : null}
      </Tag>
    );
  };
}

function DocsLink({
  href,
  children,
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const classes = cn(linkClasses, className);

  if (!href || href.startsWith("#")) {
    return (
      <a {...props} href={href} className={classes}>
        {children}
      </a>
    );
  }

  if (
    href === "/docs" ||
    href.startsWith("/docs/") ||
    href.startsWith("/docs#")
  ) {
    const hashIndex = href.indexOf("#");
    const pathname = hashIndex < 0 ? href : href.slice(0, hashIndex);
    const hash = hashIndex < 0 ? undefined : href.slice(hashIndex + 1);

    // Task 7 removes this boundary once /docs/$slug is in generated route types.
    return (
      <Link
        {...props}
        to={pathname as never}
        hash={hash}
        className={classes}
      >
        {children}
      </Link>
    );
  }

  if (/^https?:\/\//i.test(href)) {
    return (
      <a
        {...props}
        href={href}
        target="_blank"
        rel="noreferrer"
        className={classes}
      >
        {children}
        <span aria-hidden="true" className="ml-1 font-mono text-xs">
          ↗
        </span>
      </a>
    );
  }

  return (
    <a {...props} href={href} className={classes}>
      {children}
    </a>
  );
}
function DocsCallout({
  className,
  ...props
}: ComponentPropsWithoutRef<"aside">) {
  return (
    <aside
      {...props}
      role="note"
      className={cn(
        "my-6 border border-rule border-l-2 border-l-accent bg-paper-2 px-4 py-3 text-sm leading-7 text-ink-2",
        className,
      )}
    />
  );
}

function DocsPre({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"pre">) {
  const preRef = useRef<HTMLPreElement>(null);

  return (
    <div className="group relative my-6 border border-rule bg-paper-2">
      <pre
        {...props}
        ref={preRef}
        className={cn(
          "overflow-x-auto p-4 font-mono text-sm leading-6 text-ink [&>code]:border-0 [&>code]:bg-transparent [&>code]:p-0",
          className,
        )}
      >
        {children}
      </pre>
      <CopyButton
        getText={() => preRef.current?.textContent ?? ""}
        label="Copy code"
        className="absolute right-2 top-2 bg-paper-2 p-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
      />
    </div>
  );
}

function DocsTable({
  className,
  ...props
}: ComponentPropsWithoutRef<"table">) {
  return (
    <div
      role="region"
      aria-label="Scrollable table"
      tabIndex={0}
      className="my-6 overflow-x-auto border border-rule focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <table
        {...props}
        className={cn(
          "w-full min-w-max border-collapse text-left text-sm text-ink-2",
          className,
        )}
      />
    </div>
  );
}

export const docsMdxComponents = {
  h2: createHeading("h2"),
  h3: createHeading("h3"),
  h4: createHeading("h4"),
  h5: createHeading("h5"),
  h6: createHeading("h6"),
  a: DocsLink,
  p: ({ className, ...props }) => (
    <p
      {...props}
      className={cn("my-4 text-sm leading-7 text-ink-2", className)}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul
      {...props}
      className={cn(
        "my-4 list-disc space-y-2 pl-6 text-sm leading-7 text-ink-2 marker:text-accent",
        className,
      )}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      {...props}
      className={cn(
        "my-4 list-decimal space-y-2 pl-6 text-sm leading-7 text-ink-2 marker:font-mono marker:text-ink-mute",
        className,
      )}
    />
  ),
  li: ({ className, ...props }) => (
    <li {...props} className={cn("pl-1", className)} />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      {...props}
      className={cn(
        "my-6 border-l-2 border-accent bg-paper-2 px-4 py-3 text-sm leading-7 text-ink-2",
        className,
      )}
    />
  ),
  Callout: DocsCallout,
  pre: DocsPre,
  code: ({ className, ...props }) => (
    <code
      {...props}
      className={cn(
        "font-mono text-sm",
        className
          ? "text-ink"
          : "border border-rule-soft bg-paper-2 px-1 py-0.5 text-ink",
        className,
      )}
    />
  ),
  table: DocsTable,
  th: ({ className, ...props }) => (
    <th
      {...props}
      className={cn(
        "border-b border-r border-rule bg-paper-edge px-3 py-2 font-mono text-xs font-bold uppercase tracking-wide text-ink last:border-r-0",
        className,
      )}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      {...props}
      className={cn(
        "border-b border-r border-rule px-3 py-2 align-top last:border-r-0",
        className,
      )}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr {...props} className={cn("my-8 border-rule", className)} />
  ),
  strong: ({ className, ...props }) => (
    <strong
      {...props}
      className={cn("font-semibold text-ink", className)}
    />
  ),
} satisfies MDXComponents;
