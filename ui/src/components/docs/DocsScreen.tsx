import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { DocsArticle } from "#/components/docs/DocsArticle";
import { DocsLayout } from "#/components/docs/DocsLayout";
import { DEFAULT_DOC_SLUG, getDocPage } from "#/docs/registry";
import { extractDocToc } from "#/docs/toc";

export function DocsScreen({ slug }: { slug: string }) {
  const page = getDocPage(slug);
  const toc = useMemo(() => (page ? extractDocToc(page.source) : []), [page]);

  return (
    <DocsLayout activeSlug={page?.slug} toc={toc}>
      {page ? (
        <DocsArticle page={page} />
      ) : (
        <article className="mx-auto w-full max-w-3xl px-4 py-12 font-sans sm:px-6 lg:py-16">
          <p className="font-mono text-xs font-semibold uppercase tracking-widest text-accent">
            Guide unavailable
          </p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-ink sm:text-4xl">
            Documentation not found
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-ink-2">
            The requested guide is not included in this version of Clepsydra.
            Use the documentation navigation or return to the first guide.
          </p>
          <Link
            to="/docs/$slug"
            params={{ slug: DEFAULT_DOC_SLUG }}
            className="mt-7 inline-flex border border-accent bg-accent px-4 py-2 font-mono text-xs font-semibold uppercase tracking-widest text-paper outline-none transition-colors hover:bg-accent/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Open Getting Started
          </Link>
        </article>
      )}
    </DocsLayout>
  );
}
