import { Link } from "@tanstack/react-router";
import { docsMdxComponents } from "#/components/docs/DocsMdxComponents";
import { DOC_GROUPS, getDocNeighbors } from "#/docs/registry";
import type { DocPage } from "#/docs/types";

export function DocsArticle({ page }: { page: DocPage }) {
  const groupLabel =
    DOC_GROUPS.find((group) => group.id === page.groupId)?.label ?? page.groupId;
  const { previous, next } = getDocNeighbors(page.slug);
  const Component = page.Component;

  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-8 font-sans sm:px-6 lg:py-12">
      <header className="border-b border-rule pb-6">
        <nav
          aria-label="Breadcrumb"
          className="mb-4 font-mono text-xs uppercase tracking-widest text-ink-mute"
        >
          <ol className="flex flex-wrap items-center gap-2">
            <li>Documentation</li>
            <li aria-hidden="true" className="text-rule">
              /
            </li>
            <li className="text-ink-2">{groupLabel}</li>
          </ol>
        </nav>
        <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">
          {page.title}
        </h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-ink-2">
          {page.description}
        </p>
      </header>

      <div className="mt-8">
        <Component components={docsMdxComponents} />
      </div>

      {previous || next ? (
        <nav
          aria-label="Documentation pages"
          className="mt-12 grid grid-cols-1 gap-4 border-t border-rule pt-6 font-mono sm:grid-cols-2"
        >
          {previous ? (
            // Task 7 removes these boundaries after /docs/$slug is generated.
            <Link
              to={`/docs/${previous.slug}` as never}
              aria-label={`Previous: ${previous.title}`}
              className="group border border-rule bg-paper-2 px-4 py-3 text-left outline-none transition-colors hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span className="block text-xs uppercase tracking-widest text-ink-mute transition-colors group-hover:text-accent">
                <span aria-hidden="true">← </span>
                Previous
              </span>
              <span className="mt-1 block font-sans text-sm font-semibold text-ink">
                {previous.title}
              </span>
            </Link>
          ) : (
            <span aria-hidden="true" />
          )}
          {next ? (
            <Link
              to={`/docs/${next.slug}` as never}
              aria-label={`Next: ${next.title}`}
              className="group border border-rule bg-paper-2 px-4 py-3 text-right outline-none transition-colors hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span className="block text-xs uppercase tracking-widest text-ink-mute transition-colors group-hover:text-accent">
                Next
                <span aria-hidden="true"> →</span>
              </span>
              <span className="mt-1 block font-sans text-sm font-semibold text-ink">
                {next.title}
              </span>
            </Link>
          ) : null}
        </nav>
      ) : null}
    </article>
  );
}
