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
import { filterLanguages } from "#/editor/code-languages";
import { loadRefractor, useRefractor } from "#/editor/refractor-lazy";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

/** Sentinel row id for the "Plain text" reset entry (never a real lang id). */
const PLAIN = " plain";

/** Languages whose written name is not just the id with a capital. */
const LANGUAGE_NAMES: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  tsx: "TSX",
  jsx: "JSX",
  json: "JSON",
  html: "HTML",
  css: "CSS",
  scss: "SCSS",
  sql: "SQL",
  yaml: "YAML",
  toml: "TOML",
  xml: "XML",
  csv: "CSV",
  ini: "INI",
  http: "HTTP",
  php: "PHP",
  cpp: "C++",
  csharp: "C#",
  fsharp: "F#",
  graphql: "GraphQL",
  latex: "LaTeX",
  objectivec: "Objective-C",
  powershell: "PowerShell",
};

/** Sentence-case name for a language id ("python" → "Python"), or
 *  "Plain text" for none. Shared by the code-block header and this list. */
export function languageLabel(id: string | null): string {
  if (!id) return "Plain text";
  return LANGUAGE_NAMES[id] ?? `${id.charAt(0).toUpperCase()}${id.slice(1)}`;
}

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
      className="fixed z-50 w-60 rounded-[16px] bg-raise p-1.5 text-ink shadow-lg"
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
        className={cn(
          "h-9 w-full rounded-full bg-sink px-3.5 text-[14px] text-ink placeholder:text-mute",
          FOCUS_RING_NATIVE,
        )}
      />
      <div
        role="listbox"
        id={listboxId}
        aria-label="Language"
        className="cl-noscroll mt-1.5 max-h-64 overflow-y-auto"
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
                "flex h-8 cursor-pointer items-center justify-between rounded-[9px] px-3 text-[14px]",
                isPlain && "mt-1",
                isActive ? "bg-sink text-ink" : "text-ink-2",
              )}
            >
              <span>{languageLabel(isPlain ? null : row)}</span>
              {isCurrent && (
                <>
                  <span className="sr-only">selected</span>
                  <span aria-hidden="true" className="text-accent">
                    ✓
                  </span>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
