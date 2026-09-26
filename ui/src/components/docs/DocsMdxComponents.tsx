import { Link } from "@tanstack/react-router";
import type { MDXComponents } from "mdx/types";
import {
  type AnchorHTMLAttributes,
  type ComponentPropsWithoutRef,
  type HTMLAttributes,
  useRef,
} from "react";
import { CopyButton } from "#/components/ui/CopyButton";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { classifyLinkResource } from "#/lib/linkResource";

const linkClasses = cn(
  "rounded-sm text-accent underline decoration-1 underline-offset-[3px] transition-colors hover:decoration-2",
  FOCUS_RING_NATIVE,
);

/** Prose scale shared with Folio's heading descriptor (spec §5.6). */
const headingClasses = {
  h2: "relative mt-10 font-serif text-[30px] font-normal leading-[1.15] text-ink",
  h3: "mt-8 text-[19px] font-semibold leading-[1.3] text-ink",
  h4: "mt-6 text-[16px] font-semibold text-ink",
  h5: "mt-4 text-[14px] font-semibold text-ink-2",
  h6: "mt-4 text-[13px] font-medium text-mute",
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
          "group scroll-mt-6 first:mt-0",
          headingClasses[Tag],
          className,
        )}
      >
        {Tag === "h2" ? (
          // Spec §5.6: prose h2s hang a cobalt tick in the left margin.
          <span
            aria-hidden
            data-tick
            className="pointer-events-none absolute -left-[22px] top-1/2 h-2 w-2 -translate-y-1/2 rounded-[1px] bg-accent"
          />
        ) : null}
        {children}
        {id ? (
          <a
            href={`#${id}`}
            aria-label={`Link to ${id.replaceAll("-", " ")} section`}
            className={cn(
              "ml-2 rounded-sm font-sans text-[0.7em] text-mute opacity-0 transition-opacity hover:text-accent focus-visible:opacity-100 group-hover:opacity-100",
              FOCUS_RING_NATIVE,
            )}
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

    if (pathname === "/docs") {
      return (
        <Link {...props} to="/docs" hash={hash} className={classes}>
          {children}
        </Link>
      );
    }

    const slug = pathname.slice("/docs/".length);
    return (
      <Link
        {...props}
        to="/docs/$slug"
        params={{ slug }}
        hash={hash}
        className={classes}
      >
        {children}
      </Link>
    );
  }

  if (/^https?:\/\//i.test(href)) {
    const resource = classifyLinkResource(href);
    return (
      <a
        {...props}
        href={href}
        target="_blank"
        rel="noreferrer"
        className={classes}
        data-link-resource={resource ?? undefined}
      >
        {children}
        {!resource && (
          <span aria-hidden="true" className="ml-0.5 text-[0.85em]">
            ↗
          </span>
        )}
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
        "my-6 rounded-[14px] bg-accent-tint px-5 py-4 text-[15.5px] leading-[1.65] text-ink-2 [&>:first-child]:mt-0 [&>:last-child]:mb-0",
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
    <div className="group relative my-5 rounded-xl bg-sink">
      <pre
        {...props}
        ref={preRef}
        className={cn(
          "overflow-x-auto px-[22px] py-[18px] text-[13px] leading-[1.7] text-ink-2 [&>code]:rounded-none [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit",
          className,
        )}
      >
        {children}
      </pre>
      <CopyButton
        getText={() => preRef.current?.textContent ?? ""}
        label="Copy code"
        className="absolute right-2.5 top-2.5 h-8 w-8 rounded-full bg-raise opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
      />
    </div>
  );
}

function DocsTable({ className, ...props }: ComponentPropsWithoutRef<"table">) {
  return (
    <section
      aria-label="Scrollable table"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: This named overflow region must be focusable so keyboard users can scroll wide tables in browsers that do not focus scroll containers automatically.
      tabIndex={0}
      className={cn(
        "my-5 overflow-x-auto rounded-[14px] bg-raise",
        FOCUS_RING_NATIVE,
      )}
    >
      <table
        {...props}
        className={cn(
          "w-full min-w-max border-collapse text-left text-[14px] leading-[1.5] tabular-nums text-ink-2 [&_thead_tr]:bg-sink",
          className,
        )}
      />
    </section>
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
      className={cn("my-3.5 text-[17px] leading-[1.7] text-ink-2", className)}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul
      {...props}
      className={cn(
        "my-3.5 list-disc space-y-1.5 pl-6 text-[17px] leading-[1.7] text-ink-2 marker:text-accent",
        className,
      )}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      {...props}
      className={cn(
        "my-3.5 list-decimal space-y-1.5 pl-6 text-[17px] leading-[1.7] text-ink-2 marker:tabular-nums marker:text-mute",
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
        // Pull quote, as Folio's blockquote (spec §5.6): a cobalt serif
        // open-quote hangs at the left; a pseudo-element, so copies skip it.
        "relative my-8 pl-7 font-serif text-[25px] italic leading-[1.35] text-ink before:pointer-events-none before:absolute before:-left-1.5 before:-top-3.5 before:font-serif before:text-[64px] before:not-italic before:leading-none before:text-accent before:content-['“'] [&_p]:my-0 [&_p]:text-[25px] [&_p]:leading-[1.35] [&_p]:text-ink",
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
        className
          ? "text-inherit"
          : "rounded-[5px] bg-sink px-[5px] py-px text-[0.8em] text-ink",
        className,
      )}
    />
  ),
  table: DocsTable,
  th: ({ className, ...props }) => (
    <th
      {...props}
      className={cn("px-4 py-2.5 text-[13px] font-normal text-mute", className)}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      {...props}
      className={cn("px-4 py-[11px] align-top first:text-ink", className)}
    />
  ),
  // Folio's thematic break (spec decision 5: no rule lines): three faint
  // marks; the hidden <hr> keeps the separator for assistive tech.
  hr: ({ className, ...props }) => (
    <div
      className={cn(
        "my-10 flex select-none items-center justify-center gap-3",
        className,
      )}
    >
      <hr {...props} className="sr-only" />
      {[0, 1, 2].map((mark) => (
        <span
          key={mark}
          aria-hidden="true"
          className="size-[5px] rounded-[1px] bg-faint"
        />
      ))}
    </div>
  ),
  strong: ({ className, ...props }) => (
    <strong {...props} className={cn("font-semibold text-ink", className)} />
  ),
} satisfies MDXComponents;
