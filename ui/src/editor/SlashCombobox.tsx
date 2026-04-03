import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
  type VirtualElement,
} from "@floating-ui/react";
import { useCallback, useEffect, useMemo, useState } from "react";

export interface SlashCommand {
  id: string;
  label: string;
  description: string;
}

interface SlashComboboxProps {
  commands: SlashCommand[];
  query: string;
  reference: VirtualElement | null;
  onSelect: (command: SlashCommand) => void;
  onClose: () => void;
}

export function SlashCombobox({
  commands,
  query,
  reference,
  onSelect,
  onClose,
}: SlashComboboxProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { refs, floatingStyles, update } = useFloating({
    placement: "bottom-start",
    strategy: "fixed",
    middleware: [offset(6), flip(), shift({ padding: 8 })],
  });

  const lowerQuery = query.toLowerCase();
  const filtered = useMemo(
    () =>
      commands.filter(
        (c) =>
          c.label.toLowerCase().includes(lowerQuery) ||
          c.description.toLowerCase().includes(lowerQuery),
      ),
    [commands, lowerQuery],
  );

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
        case "Tab":
        case "Enter":
          e.preventDefault();
          if (filtered[selectedIndex]) onSelect(filtered[selectedIndex]);
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

  if (!reference) return null;

  if (filtered.length === 0) {
    return (
      <div
        ref={refs.setFloating}
        className="fixed z-50 border border-border bg-popover p-2 text-xs text-muted-foreground shadow-md"
        style={floatingStyles}
      >
        No commands found
      </div>
    );
  }

  return (
    <div
      ref={refs.setFloating}
      className="fixed z-50 max-h-64 overflow-y-auto border border-border bg-popover shadow-md"
      style={floatingStyles}
    >
      {filtered.map((command, index) => (
        <div
          key={command.id}
          className={`cursor-pointer px-3 py-1.5 text-sm ${index === selectedIndex ? "bg-accent text-accent-foreground" : "text-popover-foreground hover:bg-accent/50"}`}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(command);
          }}
          onMouseEnter={() => setSelectedIndex(index)}
        >
          <div className="font-medium">{command.label}</div>
          <div className="text-xs text-muted-foreground">
            {command.description}
          </div>
        </div>
      ))}
    </div>
  );
}
