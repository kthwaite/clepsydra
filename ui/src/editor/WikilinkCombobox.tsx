import type { VirtualElement } from "@floating-ui/react";
import type { PageSummary } from "#/api/types";
import { EditorSuggestionPopover } from "#/components/ui/editor-suggestion-popover";

interface WikilinkComboboxProps {
  pages: PageSummary[];
  query: string;
  reference: VirtualElement | null;
  onSelect: (page: PageSummary) => void;
  onClose: () => void;
}

export function WikilinkCombobox({
  pages,
  query,
  reference,
  onSelect,
  onClose,
}: WikilinkComboboxProps) {
  const lowerQuery = query.toLowerCase();
  const filtered = pages
    .filter(
      (p) =>
        (p.title?.toLowerCase().includes(lowerQuery) ?? false) ||
        p.canonical_name.toLowerCase().includes(lowerQuery) ||
        p.path.toLowerCase().includes(lowerQuery),
    )
    .slice(0, 8);

  return (
    <EditorSuggestionPopover
      items={filtered}
      query={query}
      reference={reference}
      onSelect={onSelect}
      onClose={onClose}
      getItemKey={(p) => p.id}
      emptyMessage="No pages found"
      renderItem={(page) => (
        <>
          <div className="font-medium">{page.title ?? page.canonical_name}</div>
          <div className="text-xs text-muted-foreground">{page.path}</div>
        </>
      )}
    />
  );
}
