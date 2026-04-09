import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { useSearch } from "#/api/index";
import { useDebounce } from "#/hooks/useDebounce";
import { useOpenTab } from "#/hooks/useOpenTab";

export function SearchPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(open ? query : "", 200);
  const { data: results } = useSearch(open ? debouncedQuery : "", 10);
  const openTab = useOpenTab();
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Cmd+K / Ctrl+K to toggle
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Reset state when opened
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
    }
  }, [open]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

  function selectResult(path: string, label?: string) {
    setOpen(false);
    openTab("page", path, label);
  }

  function onInputKeyDown(e: React.KeyboardEvent) {
    if (!results || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[selectedIndex];
      selectResult(r.path, r.title || r.path);
    }
  }

  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={setOpen}
      isDismissable
      className="fixed inset-0 z-50 flex items-start justify-center bg-foreground/20 pt-[20vh]"
    >
      <Modal className="w-full max-w-lg border border-border bg-background shadow-lg">
        <Dialog className="outline-none">
          <Heading slot="title" className="sr-only">
            Search pages
          </Heading>

          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="Search pages..."
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <kbd className="border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
              Esc
            </kbd>
          </div>

          {query && results && results.length > 0 && (
            <ul className="max-h-80 overflow-y-auto">
              {results.map((r, i) => (
                <li key={r.page_id}>
                  <button
                    type="button"
                    className={`block w-full px-4 py-2 text-left text-sm ${
                      i === selectedIndex ? "bg-accent" : "hover:bg-accent"
                    }`}
                    onClick={() => selectResult(r.path, r.title || r.path)}
                    onMouseEnter={() => setSelectedIndex(i)}
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
                  </button>
                </li>
              ))}
            </ul>
          )}

          {query && debouncedQuery && results && results.length === 0 && (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              No results for &ldquo;{query}&rdquo;
            </p>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
