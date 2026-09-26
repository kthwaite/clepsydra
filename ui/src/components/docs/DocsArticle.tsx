import { Link } from "@tanstack/react-router";
import { Suspense } from "react";
import { docsMdxComponents } from "#/components/docs/DocsMdxComponents";
import { DOC_GROUPS, getDocNeighbors } from "#/docs/registry";
import type { DocPage } from "#/docs/types";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

const NEIGHBOUR_CLASSES = cn(
  "group rounded-xl bg-sink px-4 py-3 transition-colors hover:bg-accent-tint",
  FOCUS_RING_NATIVE,
);

export function DocsArticle({ page }: { page: DocPage }) {
  const groupLabel =
    DOC_GROUPS.find((group) => group.id === page.groupId)?.label ??
    page.groupId;
  const { previous, next } = getDocNeighbors(page.slug);
  const Component = page.Component;

  return (
    <article className="mx-auto w-full max-w-[744px] px-6 pb-16 pt-6 sm:px-8 lg:pt-8">
      <header>
        <nav aria-label="Breadcrumb" className="text-[13px] text-mute">
          <ol className="flex flex-wrap items-center gap-2.5 pl-0">
            <li>Documentation</li>
            <li aria-hidden="true" className="text-faint">
              ·
            </li>
            <li>{groupLabel}</li>
          </ol>
        </nav>
        <h1 className="mt-3.5 font-serif text-[40px] font-normal leading-none tracking-[-0.015em] text-ink sm:text-[56px]">
          {page.title}
        </h1>
        <p className="mt-[18px] max-w-2xl text-[17px] leading-[1.55] text-ink-2 sm:text-[19px]">
          {page.description}
        </p>
      </header>

      <div className="mt-8">
        <Suspense
          fallback={<p className="text-[14px] text-mute">Loading guide…</p>}
        >
          <Component components={docsMdxComponents} />
        </Suspense>
      </div>

      {previous || next ? (
        <nav
          aria-label="Documentation pages"
          className="mt-14 grid grid-cols-1 gap-3 sm:grid-cols-2"
        >
          {previous ? (
            <Link
              to="/docs/$slug"
              params={{ slug: previous.slug }}
              aria-label={`Previous: ${previous.title}`}
              className={cn(NEIGHBOUR_CLASSES, "text-left")}
            >
              <span className="block text-[13px] text-mute transition-colors group-hover:text-accent">
                <span aria-hidden="true">← </span>
                Previous
              </span>
              <span className="mt-1 block text-[15px] font-medium text-ink">
                {previous.title}
              </span>
            </Link>
          ) : (
            <span aria-hidden="true" />
          )}
          {next ? (
            <Link
              to="/docs/$slug"
              params={{ slug: next.slug }}
              aria-label={`Next: ${next.title}`}
              className={cn(NEIGHBOUR_CLASSES, "text-right")}
            >
              <span className="block text-[13px] text-mute transition-colors group-hover:text-accent">
                Next
                <span aria-hidden="true"> →</span>
              </span>
              <span className="mt-1 block text-[15px] font-medium text-ink">
                {next.title}
              </span>
            </Link>
          ) : null}
        </nav>
      ) : null}
    </article>
  );
}
