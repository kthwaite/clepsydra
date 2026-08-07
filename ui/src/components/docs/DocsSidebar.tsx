import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "#/components/ui/button";
import { SearchField } from "#/components/ui/search-field";
import { DOC_GROUPS, DOC_PAGES } from "#/docs/registry";
import { buildDocsIndex, searchDocs } from "#/docs/search";
import type { DocPage, DocSearchResult } from "#/docs/types";
import { cn } from "#/lib/cn";

const DOCS_INDEX = buildDocsIndex(DOC_PAGES);

export interface DocsSidebarProps {
  activeSlug?: string;
  onNavigate?: () => void;
}

interface DocsLinkProps {
  page: DocPage;
  activeSlug?: string;
  hash?: string;
  onNavigate?: () => void;
  children: ReactNode;
  className: string;
}

function DocsLink({
  page,
  activeSlug,
  hash,
  onNavigate,
  children,
  className,
}: DocsLinkProps) {
  return (
    <Link
      // Task 7 adds the generated /docs/$slug route type and removes these casts.
      to={"/docs/$slug" as never}
      params={{ slug: page.slug } as never}
      hash={hash}
      aria-current={activeSlug === page.slug ? "page" : undefined}
      onClick={onNavigate}
      className={className}
    >
      {children}
    </Link>
  );
}

function PageLink({
  page,
  activeSlug,
  onNavigate,
}: {
  page: DocPage;
  activeSlug?: string;
  onNavigate?: () => void;
}) {
  const active = page.slug === activeSlug;

  return (
    <DocsLink
      page={page}
      activeSlug={activeSlug}
      onNavigate={onNavigate}
      className={cn(
        "block border-l-2 px-4 py-2 font-sans text-sm text-ink-2 outline-none transition-colors hover:bg-paper-edge hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        active
          ? "border-accent bg-highlight font-semibold text-ink"
          : "border-transparent",
      )}
    >
      {page.title}
    </DocsLink>
  );
}

function SearchResultLink({
  result,
  activeSlug,
  onNavigate,
}: {
  result: DocSearchResult;
  activeSlug?: string;
  onNavigate?: () => void;
}) {
  return (
    <DocsLink
      page={result.page}
      activeSlug={activeSlug}
      hash={result.headingId}
      onNavigate={onNavigate}
      className={cn(
        "group block border-l-2 border-transparent px-4 py-3 outline-none transition-colors hover:border-accent hover:bg-paper-edge focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        result.page.slug === activeSlug && "border-accent bg-highlight",
      )}
    >
      <span className="block font-sans text-sm font-semibold text-ink">
        {result.page.title}
      </span>
      {result.heading ? (
        <span className="mt-1 block font-mono text-xs uppercase tracking-wider text-accent">
          {result.heading}
        </span>
      ) : null}
      <span className="mt-1.5 block font-sans text-xs leading-5 text-ink-mute transition-colors group-hover:text-ink-2">
        {result.excerpt}
      </span>
    </DocsLink>
  );
}

export function DocsSidebar({ activeSlug, onNavigate }: DocsSidebarProps) {
  const groupIdPrefix = useId();
  const [query, setQuery] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const hasQuery = query.trim().length > 0;
  const results = hasQuery ? searchDocs(DOCS_INDEX, query) : [];

  function toggleGroup(groupId: string) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  return (
    <nav
      aria-label="Documentation"
      className="flex min-h-0 flex-1 flex-col bg-paper-2 font-mono text-ink"
    >
      <div className="border-b border-rule p-3">
        <SearchField
          aria-label="Search documentation"
          placeholder="Search documentation"
          value={query}
          onChange={setQuery}
          className="border border-rule bg-paper px-3 py-2 focus-within:border-accent"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {hasQuery ? (
          results.length > 0 ? (
            <ul aria-label="Search results">
              {results.map((result) => (
                <li
                  key={`${result.page.slug}:${result.headingId ?? "page"}`}
                  className="border-b border-rule-soft last:border-b-0"
                >
                  <SearchResultLink
                    result={result}
                    activeSlug={activeSlug}
                    onNavigate={onNavigate}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-4 py-6">
              <p className="font-sans text-sm text-ink-2">
                No documentation matches
              </p>
              <Button
                variant="secondary"
                size="sm"
                className="mt-3"
                onPress={() => setQuery("")}
                aria-label="Clear documentation search"
              >
                Clear search
              </Button>
            </div>
          )
        ) : (
          <div className="space-y-1">
            {DOC_GROUPS.map((group) => {
              const collapsed = collapsedGroups.has(group.id);
              const panelId = `${groupIdPrefix}-${group.id}`;

              return (
                <section key={group.id}>
                  <h2>
                    <button
                      type="button"
                      aria-expanded={!collapsed}
                      aria-controls={panelId}
                      onClick={() => toggleGroup(group.id)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold uppercase tracking-widest text-ink-mute outline-none transition-colors hover:bg-paper-edge hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      {collapsed ? (
                        <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
                      )}
                      {group.label}
                    </button>
                  </h2>
                  <ul id={panelId} hidden={collapsed}>
                    {group.pages.map((page) => (
                      <li key={page.slug}>
                        <PageLink
                          page={page}
                          activeSlug={activeSlug}
                          onNavigate={onNavigate}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </nav>
  );
}
