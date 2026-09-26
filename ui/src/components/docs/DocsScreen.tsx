import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { Tick } from "#/components/codex/Tick";
import { DocsArticle } from "#/components/docs/DocsArticle";
import { DocsLayout } from "#/components/docs/DocsLayout";
import { buttonStyles } from "#/components/ui/button";
import { DEFAULT_DOC_SLUG, getDocPage } from "#/docs/registry";
import { extractDocToc } from "#/docs/toc";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

export function DocsScreen({ slug }: { slug: string }) {
  const page = getDocPage(slug);
  const toc = useMemo(() => (page ? extractDocToc(page.source) : []), [page]);

  return (
    <DocsLayout activeSlug={page?.slug} toc={toc}>
      {page ? (
        <DocsArticle page={page} />
      ) : (
        <article className="mx-auto w-full max-w-[744px] px-6 pb-16 pt-10 sm:px-8 lg:pt-14">
          <div className="flex items-center gap-2.5">
            <Tick />
            <p className="font-serif text-[18px] italic leading-none text-mute">
              Guide unavailable
            </p>
          </div>
          <h1 className="mt-4 font-serif text-[40px] font-normal leading-none tracking-[-0.015em] text-ink sm:text-[56px]">
            Documentation not found
          </h1>
          <p className="mt-[18px] max-w-2xl text-[17px] leading-[1.55] text-ink-2">
            The requested guide is not included in this version of Clepsydra.
            Use the documentation navigation or return to the first guide.
          </p>
          <Link
            to="/docs/$slug"
            params={{ slug: DEFAULT_DOC_SLUG }}
            className={buttonStyles(
              "primary",
              "md",
              cn("mt-7", FOCUS_RING_NATIVE),
            )}
          >
            Open Getting Started
          </Link>
        </article>
      )}
    </DocsLayout>
  );
}
