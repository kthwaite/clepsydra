import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
} from "@floating-ui/react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { displayLabel, filterLanguages } from "#/editor/code-languages";
import { loadRefractor, useRefractor } from "#/editor/refractor-lazy";
import { cn } from "#/lib/cn";

/** Sentinel row id for the "Plain text" reset entry (never a real lang id). */
const PLAIN = " plain";

export interface CodeLangPickerProps {
  /** Current language, or null for plain text. */
  value: string | null;
  /** Element the popover anchors to (the header label button). */
  reference: HTMLElement | null;
  /** Called with a language id, or null to reset to plain text. */
  onSelect: (lang: string | null) => void;
  /** Called on Escape or click-outside. */
  onClose: () => void;
}

export function CodeLangPicker({
  value,
  reference,
  onSelect,
  onClose,
}: CodeLangPickerProps) {
  const listboxId = useId();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const { refs, floatingStyles, update } = useFloating({
    placement: "bottom-end",
    strategy: "fixed",
    middleware: [offset(6), flip(), shift({ padding: 8 })],
  });

  // The full grammar list lives in a lazy chunk (refractor-lazy.ts); until it
  // lands the curated common set stands in, then the list fills out in place.
  const highlighter = useRefractor();
  useEffect(() => {
    void loadRefractor();
  }, []);

  const langs = useMemo(
    () => filterLanguages(highlighter, query),
    [highlighter, query],
  );
  // The Plain text reset row always trails the (possibly empty) language list.
  const rows = useMemo(() => [...langs, PLAIN], [langs]);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => refs.setPositionReference(reference), [reference, refs]);
  useEffect(() => {
    if (!reference || !refs.floating.current) return;
    return autoUpdate(reference, refs.floating.current, update);
  }, [reference, refs.floating, update]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const floating = refs.floating.current;
      const target = e.target as Node;
      if (
        floating &&
        !floating.contains(target) &&
        reference &&
        !reference.contains(target)
      ) {
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [refs.floating, reference, onClose]);

  const choose = (row: string) => onSelect(row === PLAIN ? null : row);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, rows.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
      case "Tab":
        e.preventDefault();
        if (rows[selectedIndex] !== undefined) choose(rows[selectedIndex]);
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  };

  if (!reference) return null;

  const activeOptionId = `${listboxId}-option-${selectedIndex}`;

  return (
    <div
      ref={refs.setFloating}
      contentEditable={false}
      className="fixed z-50 w-56 border border-border bg-popover shadow-md"
      style={floatingStyles}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelectedIndex(0);
        }}
        onKeyDown={onKeyDown}
        placeholder="Search language…"
        role="combobox"
        aria-expanded={true}
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        className="cl-mono w-full border-b border-rule bg-paper px-3 py-1.5 text-xs text-ink outline-none placeholder:text-ink-mute"
      />
      <div
        role="listbox"
        id={listboxId}
        aria-label="Language"
        className="cl-noscroll max-h-64 overflow-y-auto"
      >
        {rows.map((row, index) => {
          const isActive = index === selectedIndex;
          const isPlain = row === PLAIN;
          const isCurrent = isPlain ? value === null : value === row;
          return (
            <div
              key={row}
              id={`${listboxId}-option-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={isActive}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(row);
              }}
              onMouseEnter={() => setSelectedIndex(index)}
              className={cn(
                "cl-mono flex cursor-pointer items-center justify-between px-3 py-1 text-xs",
                isPlain && "border-t border-rule",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-popover-foreground hover:bg-accent/50",
              )}
            >
              <span>{isPlain ? "Plain text" : displayLabel(row)}</span>
              {isCurrent && (
                <>
                  <span className="sr-only">selected</span>
                  <span aria-hidden="true">✓</span>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
