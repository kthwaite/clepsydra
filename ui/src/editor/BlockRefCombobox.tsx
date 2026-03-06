import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
  type VirtualElement,
} from "@floating-ui/react";
import { useCallback, useEffect, useState } from "react";
import type { BlockResponse } from "#/api/blocks";
import { useSearchBlocks } from "#/api/blocks";

interface BlockRefComboboxProps {
  query: string;
  reference: VirtualElement | null;
  onSelect: (block: BlockResponse) => void;
  onClose: () => void;
}

export function BlockRefCombobox({
  query,
  reference,
  onSelect,
  onClose,
}: BlockRefComboboxProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { refs, floatingStyles, update } = useFloating({
    placement: "bottom-start",
    strategy: "fixed",
    middleware: [offset(6), flip(), shift({ padding: 8 })],
  });

  const { data: blocks = [], isLoading } = useSearchBlocks(query);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, blocks.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Tab":
        case "Enter":
          e.preventDefault();
          if (blocks[selectedIndex]) {
            onSelect(blocks[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [blocks, selectedIndex, onSelect, onClose],
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

  if (isLoading && query.length >= 2) {
    return (
      <div
        ref={refs.setFloating}
        className="fixed z-50 border border-border bg-popover p-2 text-xs text-muted-foreground shadow-md"
        style={floatingStyles}
      >
        Searching...
      </div>
    );
  }

  if (blocks.length === 0) {
    return (
      <div
        ref={refs.setFloating}
        className="fixed z-50 border border-border bg-popover p-2 text-xs text-muted-foreground shadow-md"
        style={floatingStyles}
      >
        {query.length < 2 ? "Type to search blocks..." : "No blocks found"}
      </div>
    );
  }

  return (
    <div
      ref={refs.setFloating}
      className="fixed z-50 max-h-64 overflow-y-auto border border-border bg-popover shadow-md"
      style={floatingStyles}
    >
      {blocks.map((block, index) => (
        <div
          key={`${block.page_path}:${block.span_start}`}
          className={`cursor-pointer px-3 py-1.5 text-sm ${
            index === selectedIndex
              ? "bg-accent text-accent-foreground"
              : "text-popover-foreground hover:bg-accent/50"
          }`}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(block);
          }}
          onMouseEnter={() => setSelectedIndex(index)}
        >
          <div className="font-medium truncate">{block.content}</div>
          <div className="text-xs text-muted-foreground">
            {block.page_title ?? block.page_path}
            {block.block_id && (
              <span className="ml-1 opacity-50">^{block.block_id}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
