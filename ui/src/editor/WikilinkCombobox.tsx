import type { VirtualElement } from "@floating-ui/react";
import { useMemo } from "react";
import type { PageSummary } from "#/api/types";
import { EditorSuggestionPopover } from "#/components/ui/editor-suggestion-popover";
import { pageHasExactWikilinkIdentity } from "./wikilinkIdentity";

interface WikilinkComboboxProps {
  pages: PageSummary[];
  query: string;
  reference: VirtualElement | null;
  onSelect: (page: PageSummary) => void;
  onCreate: (title: string) => void;
  onClose: () => void;
  isCreating?: boolean;
  createError?: string | null;
}

type WikilinkSuggestion =
  | { kind: "page"; page: PageSummary }
  | { kind: "create"; title: string };

export function WikilinkCombobox({
  pages,
  query,
  reference,
  onSelect,
  onCreate,
  onClose,
  isCreating = false,
  createError = null,
}: WikilinkComboboxProps) {
  const lowerQuery = query.toLowerCase();
  const filteredPages = useMemo(
    () =>
      pages
        .filter(
          (p) =>
            (p.title?.toLowerCase().includes(lowerQuery) ?? false) ||
            p.canonical_name.toLowerCase().includes(lowerQuery) ||
            p.path.toLowerCase().includes(lowerQuery),
        )
        .slice(0, 8),
    [pages, lowerQuery],
  );
  const trimmedQuery = query.trim();
  const exactIdentityExists = pages.some((page) =>
    pageHasExactWikilinkIdentity(page, trimmedQuery),
  );
  const suggestions: WikilinkSuggestion[] = [
    ...filteredPages.map((page) => ({ kind: "page" as const, page })),
    ...(trimmedQuery && !exactIdentityExists
      ? [{ kind: "create" as const, title: trimmedQuery }]
      : []),
  ];

  const selectSuggestion = (suggestion: WikilinkSuggestion) => {
    if (!reference) return;
    if (suggestion.kind === "page") onSelect(suggestion.page);
    else if (!isCreating) onCreate(suggestion.title);
  };

  return (
    <EditorSuggestionPopover
      items={suggestions}
      query={query}
      reference={reference}
      onSelect={selectSuggestion}
      onClose={onClose}
      getItemKey={(suggestion) =>
        suggestion.kind === "page"
          ? `page:${suggestion.page.id}`
          : `create:${suggestion.title}`
      }
      emptyMessage={trimmedQuery ? undefined : "Type a page name"}
      renderItem={(suggestion) => {
        if (suggestion.kind === "page") {
          const { page } = suggestion;
          return (
            <>
              <div className="font-medium">
                {page.title ?? page.canonical_name}
              </div>
              <div className="text-xs text-muted-foreground">{page.path}</div>
            </>
          );
        }

        if (isCreating) return "Creating…";
        if (createError) return "Creation failed — press Enter to retry";
        return `Create “${suggestion.title}”`;
      }}
    />
  );
}
