import { Search } from "lucide-react";
import {
  Children,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useState,
} from "react";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { cn } from "#/components/ui/utils";

// ---------------------------------------------------------------------------
// CommandPaletteItem
// ---------------------------------------------------------------------------

export interface CommandPaletteItemProps {
  id: string;
  textValue: string;
  onAction: () => void;
  children: ReactNode;
  className?: string;
}

export function CommandPaletteItem({
  id,
  textValue: _textValue,
  onAction,
  children,
  className,
  ...internal
}: CommandPaletteItemProps & {
  "data-focused"?: string;
  onMouseEnter?: () => void;
}) {
  const isFocused = internal["data-focused"] === "true";

  return (
    <div
      id={id}
      role="option"
      aria-selected={isFocused}
      data-focused={isFocused ? "true" : undefined}
      className={cn(
        "block w-full cursor-default px-4 py-2 text-left text-sm",
        isFocused ? "bg-accent" : "hover:bg-accent",
        className,
      )}
      onClick={onAction}
      onMouseEnter={internal.onMouseEnter}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CommandPalette
// ---------------------------------------------------------------------------

export interface CommandPaletteProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  placeholder?: string;
  emptyMessage?: string;
  children?: ReactNode;
  className?: string;
}

export function CommandPalette({
  isOpen,
  onOpenChange,
  query,
  onQueryChange,
  placeholder = "Search...",
  emptyMessage,
  children,
  className,
}: CommandPaletteProps) {
  const listboxId = useId();
  const [focusedIndex, setFocusedIndex] = useState(0);

  // Collect item data from children
  const items = Children.toArray(children).filter(
    (child): child is React.ReactElement<CommandPaletteItemProps> =>
      child !== null &&
      typeof child === "object" &&
      "props" in child &&
      typeof (child as { props: Record<string, unknown> }).props === "object" &&
      "id" in (child as { props: Record<string, unknown> }).props,
  );

  const itemCount = items.length;

  // Reset focused index when children change
  useEffect(() => {
    setFocusedIndex(0);
  }, [itemCount]);

  const focusedItemId = items[focusedIndex]
    ? (items[focusedIndex] as React.ReactElement<CommandPaletteItemProps>).props
        .id
    : undefined;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (itemCount === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((i) => Math.min(i + 1, itemCount - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = items[focusedIndex] as
          | React.ReactElement<CommandPaletteItemProps>
          | undefined;
        item?.props.onAction();
      }
    },
    [focusedIndex, items, itemCount],
  );

  // Clone children to inject internal props
  const renderedItems = items.map((child, i) => {
    const element = child as React.ReactElement<CommandPaletteItemProps>;
    return (
      <CommandPaletteItem
        key={element.props.id}
        {...element.props}
        data-focused={i === focusedIndex ? "true" : undefined}
        onMouseEnter={() => setFocusedIndex(i)}
      />
    );
  });

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="fixed inset-0 z-50 flex items-start justify-center bg-foreground/20 pt-[20vh]"
    >
      <Modal
        className={cn(
          "w-full max-w-lg border border-border bg-background shadow-lg",
          className,
        )}
      >
        <Dialog className="outline-none">
          <Heading slot="title" className="sr-only">
            {placeholder}
          </Heading>

          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              role="combobox"
              type="text"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              aria-expanded={itemCount > 0}
              aria-controls={listboxId}
              aria-activedescendant={focusedItemId}
              autoComplete="off"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <kbd className="border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
              Esc
            </kbd>
          </div>

          {itemCount > 0 && (
            <div
              id={listboxId}
              role="listbox"
              className="max-h-80 overflow-y-auto"
            >
              {renderedItems}
            </div>
          )}

          {emptyMessage && itemCount === 0 && (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              {emptyMessage}
            </p>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
