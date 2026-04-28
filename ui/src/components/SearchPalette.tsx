import { useEffect, useState } from "react";
import { useSearch } from "#/api/index";
import {
  CommandPalette,
  CommandPaletteItem,
} from "#/components/ui/command-palette";
import { useDebounce } from "#/hooks/useDebounce";
import { useOpenTab } from "#/hooks/useOpenTab";
import { useUiStore } from "#/store/ui";

export function SearchPalette() {
  const open = useUiStore((s) => s.isSearchOpen);
  const setOpen = useUiStore((s) => s.setSearchOpen);
  const toggleSearch = useUiStore((s) => s.toggleSearch);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(open ? query : "", 200);
  const { data: results } = useSearch(open ? debouncedQuery : "", 10);
  const openTab = useOpenTab();

  // Cmd+K / Ctrl+K to toggle
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        toggleSearch();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleSearch]);

  // Reset query when opened
  useEffect(() => {
    if (open) {
      setQuery("");
    }
  }, [open]);

  function selectResult(path: string, label?: string) {
    setOpen(false);
    openTab("page", path, label);
  }

  const hasQuery = query.length > 0 && debouncedQuery.length > 0;
  const noResults = hasQuery && results && results.length === 0;

  return (
    <CommandPalette
      isOpen={open}
      onOpenChange={setOpen}
      query={query}
      onQueryChange={setQuery}
      placeholder="Search pages..."
      emptyMessage={
        noResults ? `No results for \u201c${query}\u201d` : undefined
      }
    >
      {query && results
        ? results.map((r) => (
            <CommandPaletteItem
              key={r.page_id}
              id={r.page_id}
              textValue={r.title || r.path}
              onAction={() => selectResult(r.path, r.title || r.path)}
            >
              <span className="font-medium">{r.title || r.path}</span>
              {r.title && (
                <span className="ml-2 text-xs text-muted-foreground">
                  {r.path}
                </span>
              )}
              {r.snippet && (
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {r.snippet.replace(/<\/?mark>/g, "")}
                </p>
              )}
            </CommandPaletteItem>
          ))
        : null}
    </CommandPalette>
  );
}
