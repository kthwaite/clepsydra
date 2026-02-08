import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSearch } from "#/api/index";
import { useDebounce } from "#/hooks/useDebounce";

export function SearchPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(query, 200);
  const { data: results } = useSearch(debouncedQuery, 10);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Cmd+K / Ctrl+K to toggle
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

  function selectResult(path: string) {
    setOpen(false);
    navigate({ to: "/pages/$", params: { _splat: path } });
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
      selectResult(results[selectedIndex].path);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-foreground/20 pt-[20vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg border border-border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            ref={inputRef}
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

        {debouncedQuery && results && results.length > 0 && (
          <ul className="max-h-80 overflow-y-auto">
            {results.map((r, i) => (
              <li key={r.page_id}>
                <button
                  type="button"
                  className={`block w-full px-4 py-2 text-left text-sm ${
                    i === selectedIndex ? "bg-accent" : "hover:bg-accent"
                  }`}
                  onClick={() => selectResult(r.path)}
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

        {debouncedQuery && results && results.length === 0 && (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            No results for &ldquo;{debouncedQuery}&rdquo;
          </p>
        )}
      </div>
    </div>
  );
}
