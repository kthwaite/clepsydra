import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
  type VirtualElement,
} from "@floating-ui/react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { cn } from "#/lib/cn";

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
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [previousQuery, setPreviousQuery] = useState(query);
  const { refs, floatingStyles, update, isPositioned } = useFloating({
    placement: "bottom-start",
    strategy: "fixed",
    middleware: [offset(6), flip(), shift({ padding: 8 })],
  });
  // The popover mounts before floating-ui has measured the reference; keep it
  // invisible and click-through until positioned so it doesn't flash at the
  // viewport origin. (Not visibility:hidden — that would drop it from the
  // accessibility tree while unpositioned.)
  const positionedStyles = isPositioned
    ? floatingStyles
    : { ...floatingStyles, opacity: 0, pointerEvents: "none" as const };
  const activeIndex = Math.min(
    Math.max(selectedIndex, 0),
    Math.max(items.length - 1, 0),
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          if (items.length === 0) break;
          e.preventDefault();
          setSelectedIndex(Math.min(activeIndex + 1, items.length - 1));
          break;
        case "ArrowUp":
          if (items.length === 0) break;
          e.preventDefault();
          setSelectedIndex(Math.max(activeIndex - 1, 0));
          break;
        case "Tab":
        case "Enter":
          e.preventDefault();
          if (items[activeIndex]) onSelect(items[activeIndex]);
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [items, activeIndex, onSelect, onClose],
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

  // Reset before committing a new query so it never renders a stale option.
  if (query !== previousQuery) {
    setPreviousQuery(query);
    setSelectedIndex(0);
  }

  if (!reference) return null;

  if (isLoading && items.length === 0) {
    return (
      <div
        ref={refs.setFloating}
        className="fixed z-50 border border-border bg-popover p-2 text-xs text-muted-foreground shadow-md"
        style={positionedStyles}
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
        style={positionedStyles}
      >
        {emptyMessage}
      </div>
    );
  }

  return (
    <div
      ref={refs.setFloating}
      role="listbox"
      className="fixed z-50 max-h-64 overflow-y-auto border border-border bg-popover shadow-md"
      style={positionedStyles}
    >
      {items.map((item, index) => {
        const itemKey = getItemKey(item);
        const isActive = index === activeIndex;
        return (
          <div
            key={itemKey}
            role="option"
            aria-selected={isActive}
            tabIndex={-1}
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
