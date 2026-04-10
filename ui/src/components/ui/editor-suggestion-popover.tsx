import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
  type VirtualElement,
} from "@floating-ui/react";
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { cn } from "#/components/ui/utils";

export interface EditorSuggestionPopoverProps<T> {
  items: T[];
  query: string;
  reference: VirtualElement | null;
  onSelect: (item: T) => void;
  onClose: () => void;
  renderItem: (item: T, isActive: boolean) => ReactNode;
  getItemKey: (item: T) => string;
  emptyMessage?: ReactNode;
  isLoading?: boolean;
}

export function EditorSuggestionPopover<T>({
  items,
  query,
  reference,
  onSelect,
  onClose,
  renderItem,
  getItemKey,
  emptyMessage,
  isLoading,
}: EditorSuggestionPopoverProps<T>) {
  const listboxId = useId();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { refs, floatingStyles, update } = useFloating({
    placement: "bottom-start",
    strategy: "fixed",
    middleware: [offset(6), flip(), shift({ padding: 8 })],
  });

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Tab":
        case "Enter":
          e.preventDefault();
          if (items[selectedIndex]) onSelect(items[selectedIndex]);
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [items, selectedIndex, onSelect, onClose],
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

  if (!reference) return null;

  if (isLoading && items.length === 0) {
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

  if (items.length === 0) {
    if (!emptyMessage) return null;
    return (
      <div
        ref={refs.setFloating}
        className="fixed z-50 border border-border bg-popover p-2 text-xs text-muted-foreground shadow-md"
        style={floatingStyles}
      >
        {emptyMessage}
      </div>
    );
  }

  const activeOptionId = `${listboxId}-option-${selectedIndex}`;

  return (
    <div
      ref={refs.setFloating}
      role="listbox"
      id={listboxId}
      aria-activedescendant={activeOptionId}
      className="fixed z-50 max-h-64 overflow-y-auto border border-border bg-popover shadow-md"
      style={floatingStyles}
    >
      {items.map((item, index) => {
        const optionId = `${listboxId}-option-${index}`;
        const isActive = index === selectedIndex;
        return (
          <div
            key={getItemKey(item)}
            id={optionId}
            role="option"
            aria-selected={isActive}
            className={cn(
              "cursor-pointer px-3 py-1.5 text-sm",
              isActive
                ? "bg-accent text-accent-foreground"
                : "text-popover-foreground hover:bg-accent/50",
            )}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(item);
            }}
            onMouseEnter={() => setSelectedIndex(index)}
          >
            {renderItem(item, isActive)}
          </div>
        );
      })}
    </div>
  );
}
