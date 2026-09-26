import { Link, useRouter } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { type MouseEvent, type ReactNode, useId, useState } from "react";
import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";
import { SearchField } from "#/components/ui/search-field";
import { DOC_GROUPS, DOC_PAGES } from "#/docs/registry";
import { buildDocsIndex, searchDocs } from "#/docs/search";
import type { DocPage, DocSearchResult } from "#/docs/types";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

const DOCS_INDEX = buildDocsIndex(DOC_PAGES);

export interface DocsSidebarProps {
  activeSlug?: string;
  onNavigate?: () => void;
}

interface DocsLinkProps {
  page: DocPage;
  isCurrent?: boolean;
  includeHashInCurrent?: boolean;
  hash?: string;
  onNavigate?: () => void;
  children: ReactNode;
  className: string;
}

function DocsLink({
  page,
  isCurrent,
  includeHashInCurrent = false,
  hash,
  onNavigate,
  children,
  className,
}: DocsLinkProps) {
  const router = useRouter();

  async function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    event.preventDefault();
    await router.navigate({
      to: "/docs/$slug",
      params: { slug: page.slug },
      hash,
    });

    if (
      router.state.location.pathname === `/docs/${page.slug}` &&
      router.state.location.hash === (hash ?? "")
    ) {
      onNavigate?.();
    }
  }

  return (
    <Link
      to="/docs/$slug"
      params={{ slug: page.slug }}
      hash={hash}
      activeOptions={{ exact: true, includeHash: includeHashInCurrent }}
      aria-current={isCurrent ? "page" : undefined}
      onClick={onNavigate ? handleClick : undefined}
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
      isCurrent={active}
      onNavigate={onNavigate}
      className={cn(
        "flex min-h-[34px] items-center rounded-[10px] px-3 py-1.5 text-[14px] transition-colors",
        FOCUS_RING_NATIVE,
        active
          ? "bg-accent-tint font-medium text-ink"
          : "text-ink-2 hover:bg-raise hover:text-ink",
      )}
    >
      {page.title}
    </DocsLink>
  );
}

function SearchResultLink({
  result,
  onNavigate,
}: {
  result: DocSearchResult;
  onNavigate?: () => void;
}) {
  return (
    <DocsLink
      page={result.page}
      includeHashInCurrent
      hash={result.headingId}
      onNavigate={onNavigate}
      className={cn(
        "group block rounded-[10px] px-3 py-2.5 transition-colors hover:bg-raise",
        FOCUS_RING_NATIVE,
      )}
    >
      <span className="block text-[14px] font-medium text-ink">
        {result.page.title}
      </span>
      {result.heading ? (
        <span className="mt-0.5 block text-[13px] text-accent">
          {result.heading}
        </span>
      ) : null}
      <span className="mt-1 block text-[13px] leading-5 text-mute transition-colors group-hover:text-ink-2">
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
      className="flex min-h-0 flex-1 flex-col gap-3.5 px-3 pb-4 pt-4 text-ink"
    >
      <div className="shrink-0 pl-1">
        <SearchField
          aria-label="Search documentation"
          placeholder="Search documentation"
          value={query}
          onChange={setQuery}
          className="bg-raise"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pl-1">
        {hasQuery ? (
          results.length > 0 ? (
            <ul
              aria-label="Search results"
              className="flex flex-col gap-1 pl-0"
            >
              {results.map((result) => (
                <li key={`${result.page.slug}:${result.headingId ?? "page"}`}>
                  <SearchResultLink result={result} onNavigate={onNavigate} />
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-3 py-4">
              <p className="text-[14px] text-ink-2">No documentation matches</p>
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
          <div className="flex flex-col gap-0.5">
            {DOC_GROUPS.map((group) => {
              const collapsed = collapsedGroups.has(group.id);
              const panelId = `${groupIdPrefix}-${group.id}`;
              const buttonId = `${panelId}-button`;
              const holdsCurrent = group.pages.some(
                (page) => page.slug === activeSlug,
              );

              return (
                <section key={group.id}>
                  <h2 className="font-normal">
                    <button
                      type="button"
                      id={buttonId}
                      aria-expanded={!collapsed}
                      aria-controls={panelId}
                      onClick={() => toggleGroup(group.id)}
                      className={cn(
                        "flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-[10px] py-1.5 pr-2 text-left text-mute transition-colors hover:text-ink",
                        FOCUS_RING_NATIVE,
                      )}
                    >
                      <Tick variant={holdsCurrent ? "live" : "faint"} />
                      <span className="min-w-0 flex-1 font-serif text-[18px] italic leading-tight">
                        {group.label}
                      </span>
                      {collapsed ? (
                        <ChevronRight
                          aria-hidden="true"
                          className="h-3.5 w-3.5 shrink-0"
                        />
                      ) : (
                        <ChevronDown
                          aria-hidden="true"
                          className="h-3.5 w-3.5 shrink-0"
                        />
                      )}
                    </button>
                  </h2>
                  <ul
                    id={panelId}
                    aria-labelledby={buttonId}
                    hidden={collapsed}
                    className="mb-2 mt-0.5 flex flex-col gap-0.5 pl-[5px]"
                  >
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
