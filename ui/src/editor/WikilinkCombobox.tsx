import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
  type VirtualElement,
} from "@floating-ui/react";
import { useCallback, useEffect, useState } from "react";
import type { PageSummary } from "#/api/types";

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
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { refs, floatingStyles, update } = useFloating({
    placement: "bottom-start",
    strategy: "fixed",
    middleware: [offset(6), flip(), shift({ padding: 8 })],
  });

  const lowerQuery = query.toLowerCase();
  const filtered = pages
    .filter(
      (p) =>
        (p.title?.toLowerCase().includes(lowerQuery) ?? false) ||
        p.canonical_name.toLowerCase().includes(lowerQuery) ||
        p.path.toLowerCase().includes(lowerQuery),
    )
    .slice(0, 8);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (filtered[selectedIndex]) {
            onSelect(filtered[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [filtered, selectedIndex, onSelect, onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [handleKeyDown]);

  useEffect(() => {
    refs.setPositionReference(reference);
  }, [reference, refs]);

  useEffect(() => {
    if (!reference || !refs.floating.current) return;
    return autoUpdate(reference, refs.floating.current, update);
  }, [reference, refs.floating, update]);

  if (!reference) {
    return null;
  }

  if (filtered.length === 0) {
    return (
      <div
        ref={refs.setFloating}
        className="fixed z-50 border border-border bg-popover p-2 text-xs text-muted-foreground shadow-md"
        style={floatingStyles}
      >
        No pages found
      </div>
    );
  }

  return (
    <div
      ref={refs.setFloating}
      className="fixed z-50 max-h-64 overflow-y-auto border border-border bg-popover shadow-md"
      style={floatingStyles}
    >
      {filtered.map((page, index) => (
        <div
          key={page.id}
          className={`cursor-pointer px-3 py-1.5 text-sm ${
            index === selectedIndex
              ? "bg-accent text-accent-foreground"
              : "text-popover-foreground hover:bg-accent/50"
          }`}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(page);
          }}
          onMouseEnter={() => setSelectedIndex(index)}
        >
          <div className="font-medium">{page.title ?? page.canonical_name}</div>
          <div className="text-xs text-muted-foreground">{page.path}</div>
        </div>
      ))}
    </div>
  );
}
