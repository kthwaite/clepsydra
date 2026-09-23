import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
} from "@floating-ui/react";
import {
  Bold,
  Code2,
  Eraser,
  Highlighter,
  Italic,
  Link2,
  type LucideIcon,
  Palette,
  Strikethrough,
  Subscript,
  Superscript,
  Underline,
} from "lucide-react";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { TooltipTrigger } from "react-aria-components";
import {
  type BaseRange,
  Editor,
  Path,
  Range,
  type Editor as SlateEditor,
  Element as SlateElement,
  Text,
  Transforms,
} from "slate";
import { ReactEditor, useSlate } from "slate-react";
import type { PageSummary } from "#/api/types";
import { IconButton } from "#/components/ui/icon-button";
import { VesselTooltip } from "#/components/ui/tooltip";
import { makeLink } from "#/editor/schema/elements/link";
import { makeWikilink } from "#/editor/schema/elements/wikilink";
import type { CustomText } from "#/editor/schema/types";
import { cn } from "#/lib/cn";
import { createRangeReference } from "./floatingSelectionReference";

const BOOLEAN_CONTROLS = [
  { label: "Bold", mark: "bold", Icon: Bold },
  { label: "Italic", mark: "italic", Icon: Italic },
  { label: "Underline", mark: "underline", Icon: Underline },
  {
    label: "Strikethrough",
    mark: "strikethrough",
    Icon: Strikethrough,
  },
  { label: "Subscript", mark: "subscript", Icon: Subscript },
  { label: "Superscript", mark: "superscript", Icon: Superscript },
  { label: "Inline code", mark: "code", Icon: Code2 },
] as const satisfies ReadonlyArray<{
  label: string;
  mark: keyof CustomText;
  Icon: LucideIcon;
}>;

const TEXT_SWATCHES = [
  { name: "Slate", value: "light-dark(#334155, #cbd5e1)" },
  { name: "Crimson", value: "light-dark(#be123c, #fda4af)" },
  { name: "Amber", value: "light-dark(#92400e, #fcd34d)" },
  { name: "Emerald", value: "light-dark(#047857, #6ee7b7)" },
  { name: "Indigo", value: "light-dark(#4338ca, #a5b4fc)" },
] as const;

const HIGHLIGHT_SWATCHES = [
  { name: "Lemon", value: "light-dark(#fef08a, #713f12)" },
  { name: "Mint", value: "light-dark(#bbf7d0, #14532d)" },
  { name: "Sky", value: "light-dark(#bae6fd, #0c4a6e)" },
  { name: "Rose", value: "light-dark(#fecdd3, #881337)" },
  { name: "Lavender", value: "light-dark(#ddd6fe, #4c1d95)" },
] as const;

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

type BooleanMark = (typeof BOOLEAN_CONTROLS)[number]["mark"];
type ColourMark = "color" | "backgroundColor";
type PressedState = boolean | "mixed";
type OpenPalette = "highlight" | "text" | null;

interface SelectionInspection {
  textNodes: CustomText[];
  touchesCode: boolean;
}

interface TooltipIconButtonProps {
  children: ReactNode;
  controls?: string;
  expanded?: boolean;
  label: string;
  pressed?: PressedState;
  onPress: () => void;
}

interface Swatch {
  name: string;
  value: string;
}

interface ColourPanelProps {
  id: string;
  paletteName: string;
  customName: string;
  customDefault: string;
  clearName: string;
  mark: ColourMark;
  swatches: readonly Swatch[];
  textNodes: CustomText[];
  onApply: (value: string | undefined) => void;
}

function cloneRange(range: BaseRange): BaseRange {
  return {
    anchor: {
      path: [...range.anchor.path],
      offset: range.anchor.offset,
    },
    focus: {
      path: [...range.focus.path],
      offset: range.focus.offset,
    },
  };
}

function inspectSelection(
  editor: SlateEditor,
  selection: BaseRange,
): SelectionInspection {
  const textNodes: CustomText[] = [];
  let touchesCode = false;
  const [start, end] = Range.edges(selection);
  const normalizedSelection: BaseRange = { anchor: start, focus: end };

  for (const [node, path] of Editor.nodes<CustomText>(editor, {
    at: normalizedSelection,
    match: Text.isText,
  })) {
    const intersection = Range.intersection(
      normalizedSelection,
      Editor.range(editor, path),
    );
    if (!intersection || Range.isCollapsed(intersection)) continue;

    textNodes.push(node);
    if (node.code) {
      touchesCode = true;
      continue;
    }
    if (
      Editor.above(editor, {
        at: path,
        match: (ancestor) =>
          SlateElement.isElement(ancestor) && ancestor.type === "code-block",
      })
    ) {
      touchesCode = true;
    }
  }

  return { textNodes, touchesCode };
}

function booleanMarkState(
  textNodes: CustomText[],
  mark: BooleanMark,
): PressedState {
  let markedCount = 0;
  for (const node of textNodes) {
    if (node[mark] === true) markedCount += 1;
  }
  if (markedCount === 0) return false;
  if (markedCount === textNodes.length) return true;
  return "mixed";
}

function swatchState(
  textNodes: CustomText[],
  mark: ColourMark,
  value: string,
): PressedState {
  let matchingCount = 0;
  for (const node of textNodes) {
    if (node[mark] === value) matchingCount += 1;
  }
  if (matchingCount === 0) return false;
  if (matchingCount === textNodes.length) return true;
  return "mixed";
}

function nativeColourValue(
  textNodes: CustomText[],
  mark: ColourMark,
  fallback: string,
): string {
  const firstValue = textNodes[0]?.[mark];
  if (typeof firstValue !== "string" || !HEX_COLOUR.test(firstValue)) {
    return fallback;
  }
  for (let index = 1; index < textNodes.length; index += 1) {
    if (textNodes[index]?.[mark] !== firstValue) return fallback;
  }
  return firstValue;
}

function preserveEditorSelection(event: ReactPointerEvent<HTMLElement>) {
  event.preventDefault();
}

function TooltipIconButton({
  children,
  controls,
  expanded,
  label,
  pressed,
  onPress,
}: TooltipIconButtonProps) {
  return (
    <TooltipTrigger delay={300} closeDelay={0}>
      <IconButton
        aria-label={label}
        aria-controls={controls}
        aria-expanded={expanded}
        aria-pressed={pressed}
        variant="ghost"
        className={cn(
          "h-7 w-7 border-transparent text-ink-mute hover:text-ink",
          pressed === true && "bg-accent/15 text-accent",
          pressed === "mixed" && "bg-accent/10 text-accent/80",
        )}
        onPointerDown={preserveEditorSelection}
        onPress={onPress}
      >
        {children}
      </IconButton>
      <VesselTooltip>{label}</VesselTooltip>
    </TooltipTrigger>
  );
}

function ColourPanel({
  id,
  paletteName,
  customName,
  customDefault,
  clearName,
  mark,
  swatches,
  textNodes,
  onApply,
}: ColourPanelProps) {
  return (
    <fieldset
      id={id}
      className="flex items-center gap-1 border-t border-rule px-1 py-1"
    >
      <legend className="sr-only">{paletteName}</legend>
      {swatches.map((swatch) => (
        <TooltipTrigger key={swatch.value} delay={300} closeDelay={0}>
          <IconButton
            aria-label={swatch.name}
            aria-pressed={swatchState(textNodes, mark, swatch.value)}
            variant="ghost"
            className="h-6 w-6 border-transparent p-1 data-[focus-visible]:outline-accent"
            onPointerDown={preserveEditorSelection}
            onPress={() => onApply(swatch.value)}
          >
            <span
              aria-hidden="true"
              className="h-3.5 w-3.5 border border-black/20"
              style={{ backgroundColor: swatch.value }}
            />
          </IconButton>
          <VesselTooltip>{swatch.name}</VesselTooltip>
        </TooltipTrigger>
      ))}
      <input
        aria-label={customName}
        title={customName}
        type="color"
        value={nativeColourValue(textNodes, mark, customDefault)}
        className="h-6 w-6 cursor-pointer border border-rule bg-paper p-0"
        onChange={(event) => onApply(event.currentTarget.value)}
      />
      <TooltipIconButton label={clearName} onPress={() => onApply(undefined)}>
        <Eraser />
      </TooltipIconButton>
    </fieldset>
  );
}

export interface SelectionBubbleMenuProps {
  readOnly: boolean;
  pages?: Pick<PageSummary, "title" | "canonical_name" | "path">[];
}

export function SelectionBubbleMenu({
  readOnly,
  pages = [],
}: SelectionBubbleMenuProps) {
  const editor = useSlate();
  const selection = editor.selection;
  const highlightPanelId = useId();
  const textPanelId = useId();
  const linkPanelId = useId();
  const linkListId = useId();
  const linkInputRef = useRef<HTMLInputElement>(null);
  const preservedRangeRef = useRef<BaseRange | null>(null);
  const previousSelectionRef = useRef<BaseRange | null>(null);
  const [openPalette, setOpenPalette] = useState<OpenPalette>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkQuery, setLinkQuery] = useState("");
  const [linkIndex, setLinkIndex] = useState(0);

  const inspection =
    !readOnly && selection && !Range.isCollapsed(selection)
      ? inspectSelection(editor, selection)
      : null;
  const visible = Boolean(
    !readOnly &&
      selection &&
      !Range.isCollapsed(selection) &&
      inspection &&
      inspection.textNodes.length > 0 &&
      !inspection.touchesCode,
  );

  if (visible && selection) {
    preservedRangeRef.current = cloneRange(selection);
  }

  useEffect(() => {
    const previousSelection = previousSelectionRef.current;
    const selectionChanged = previousSelection
      ? !selection || !Range.equals(previousSelection, selection)
      : selection !== null;
    if (selectionChanged || !visible) {
      setOpenPalette(null);
      setLinkOpen(false);
    }
    previousSelectionRef.current = selection ? cloneRange(selection) : null;
  }, [selection, visible]);

  useEffect(() => {
    if (linkOpen) linkInputRef.current?.focus();
  }, [linkOpen]);

  const reference = useMemo(
    () =>
      visible && selection ? createRangeReference(editor, selection) : null,
    [editor, selection, visible],
  );
  const { refs, floatingStyles, update } = useFloating({
    placement: "top",
    strategy: "fixed",
    middleware: [offset(8), flip(), shift({ padding: 8 })],
  });

  useEffect(() => {
    refs.setPositionReference(reference);
  }, [reference, refs]);

  useEffect(() => {
    const floatingElement = refs.floating.current;
    if (!reference || !floatingElement) return;
    return autoUpdate(reference, floatingElement, update);
  }, [reference, refs.floating, update]);

  const applyToPreservedRange = useCallback(
    (apply: () => void) => {
      const preservedRange = preservedRangeRef.current;
      if (!preservedRange) return;

      Transforms.select(editor, cloneRange(preservedRange));
      Editor.withoutNormalizing(editor, apply);

      if (editor.selection && !Range.isCollapsed(editor.selection)) {
        preservedRangeRef.current = cloneRange(editor.selection);
      }
      ReactEditor.focus(editor);
    },
    [editor],
  );

  const toggleBooleanMark = useCallback(
    (mark: BooleanMark, state: PressedState) => {
      applyToPreservedRange(() => {
        if (state === true) {
          Editor.removeMark(editor, mark);
          return;
        }
        if (mark === "subscript") Editor.removeMark(editor, "superscript");
        if (mark === "superscript") Editor.removeMark(editor, "subscript");
        Editor.addMark(editor, mark, true);
      });
    },
    [applyToPreservedRange, editor],
  );

  const applyColour = useCallback(
    (mark: ColourMark, value: string | undefined) => {
      applyToPreservedRange(() => {
        if (value) {
          Editor.addMark(editor, mark, value);
        } else {
          Editor.removeMark(editor, mark);
        }
      });
    },
    [applyToPreservedRange, editor],
  );
  const startBlock = selection
    ? Editor.above(editor, {
        at: Range.start(selection),
        match: (node) =>
          SlateElement.isElement(node) && Editor.isBlock(editor, node),
      })
    : null;
  const endBlock = selection
    ? Editor.above(editor, {
        at: Range.end(selection),
        match: (node) =>
          SlateElement.isElement(node) && Editor.isBlock(editor, node),
      })
    : null;
  const linkable = Boolean(
    visible &&
      selection &&
      startBlock &&
      endBlock &&
      Path.equals(startBlock[1], endBlock[1]) &&
      !Editor.above(editor, {
        at: Range.start(selection),
        match: (node) => SlateElement.isElement(node) && node.type === "link",
      }) &&
      Editor.nodes(editor, {
        at: selection,
        match: (node) =>
          SlateElement.isElement(node) &&
          (node.type === "link" || node.type === "wikilink"),
      }).next().done,
  );
  const query = linkQuery.toLowerCase();
  const matches = linkOpen
    ? pages
        .filter(
          (page) =>
            (page.title ?? page.canonical_name).toLowerCase().includes(query) ||
            page.canonical_name.toLowerCase().includes(query) ||
            page.path.toLowerCase().includes(query),
        )
        .slice(0, 8)
    : [];
  const url = linkQuery.trim();
  const externalUrl =
    /^https?:\/\/\S+$/i.test(url) && URL.canParse(url) ? url : null;

  const insertLink = (target: string, kind: "page" | "url") => {
    const range = preservedRangeRef.current;
    if (!range) return;
    let label: string;
    try {
      label = Editor.string(editor, range);
    } catch {
      setLinkOpen(false);
      return;
    }
    if (!label) return;
    Transforms.select(editor, cloneRange(range));
    if (kind === "page") {
      Transforms.insertNodes(editor, makeWikilink({ target, alias: label }));
    } else {
      Transforms.wrapNodes(editor, makeLink({ url: target }), {
        at: range,
        split: true,
      });
    }
    setLinkOpen(false);
    ReactEditor.focus(editor);
  };

  if (!visible || !selection || !inspection || !reference) return null;

  return (
    <div
      ref={refs.setFloating}
      role="toolbar"
      aria-label="Text formatting"
      className="fixed z-50 flex flex-col border border-rule bg-paper-2 text-ink shadow-md"
      style={floatingStyles}
    >
      <div className="flex items-center gap-0.5 p-1">
        {BOOLEAN_CONTROLS.map(({ label, mark, Icon }) => {
          const state = booleanMarkState(inspection.textNodes, mark);
          return (
            <TooltipIconButton
              key={mark}
              label={label}
              pressed={state}
              onPress={() => toggleBooleanMark(mark, state)}
            >
              <Icon />
            </TooltipIconButton>
          );
        })}
        {linkable && (
          <TooltipIconButton
            label="Add link"
            controls={linkPanelId}
            expanded={linkOpen}
            onPress={() => {
              setOpenPalette(null);
              setLinkQuery("");
              setLinkIndex(0);
              setLinkOpen((current) => !current);
            }}
          >
            <Link2 />
          </TooltipIconButton>
        )}
        <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-rule" />
        <TooltipIconButton
          label="Highlight colour"
          controls={highlightPanelId}
          expanded={openPalette === "highlight"}
          onPress={() =>
            setOpenPalette((current) =>
              current === "highlight" ? null : "highlight",
            )
          }
        >
          <Highlighter />
        </TooltipIconButton>
        <TooltipIconButton
          label="Text colour"
          controls={textPanelId}
          expanded={openPalette === "text"}
          onPress={() =>
            setOpenPalette((current) => (current === "text" ? null : "text"))
          }
        >
          <Palette />
        </TooltipIconButton>
      </div>
      {linkOpen && (
        <div
          id={linkPanelId}
          className="w-72 border-t border-rule p-2"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <input
            ref={linkInputRef}
            role="combobox"
            aria-controls={linkListId}
            aria-autocomplete="list"
            aria-expanded={matches.length > 0 || Boolean(externalUrl)}
            aria-activedescendant={
              matches.length > 0 || externalUrl
                ? `${linkListId}-option-${linkIndex}`
                : undefined
            }
            aria-label="Link target"
            placeholder="Find a page or enter a URL"
            value={linkQuery}
            onChange={(event) => {
              setLinkQuery(event.target.value);
              setLinkIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setLinkOpen(false);
                ReactEditor.focus(editor);
              } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setLinkIndex((current) =>
                  Math.max(
                    0,
                    Math.min(
                      matches.length + Number(Boolean(externalUrl)) - 1,
                      current + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  ),
                );
              } else if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                const page = matches[linkIndex];
                if (page) insertLink(page.title ?? page.canonical_name, "page");
                else if (externalUrl) insertLink(externalUrl, "url");
              }
            }}
            className="w-full border border-rule bg-paper px-2 py-1 text-sm text-ink outline-accent"
          />
          {matches.length > 0 || externalUrl ? (
            <div
              id={linkListId}
              role="listbox"
              aria-label="Link targets"
              className="mt-1 max-h-52 overflow-y-auto"
            >
              {matches.map((page, index) => (
                <div
                  key={page.path}
                  role="option"
                  id={`${linkListId}-option-${index}`}
                  tabIndex={-1}
                  aria-selected={linkIndex === index}
                  onMouseEnter={() => setLinkIndex(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    insertLink(page.title ?? page.canonical_name, "page");
                  }}
                  className={cn(
                    "cursor-pointer px-2 py-1 text-sm hover:bg-accent/20",
                    linkIndex === index && "bg-accent/20",
                  )}
                >
                  <div>{page.title ?? page.canonical_name}</div>
                  <div className="truncate text-xs text-ink-mute">
                    {page.path}
                  </div>
                </div>
              ))}
              {externalUrl && (
                <div
                  role="option"
                  id={`${linkListId}-option-${matches.length}`}
                  tabIndex={-1}
                  aria-selected={linkIndex === matches.length}
                  onMouseEnter={() => setLinkIndex(matches.length)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    insertLink(externalUrl, "url");
                  }}
                  className={cn(
                    "cursor-pointer px-2 py-1 text-sm hover:bg-accent/20",
                    linkIndex === matches.length && "bg-accent/20",
                  )}
                >
                  Link to URL
                </div>
              )}
            </div>
          ) : (
            <p className="pt-2 text-xs text-ink-mute">No matching pages</p>
          )}
        </div>
      )}

      {openPalette === "highlight" ? (
        <ColourPanel
          id={highlightPanelId}
          paletteName="Highlight colour palette"
          customName="Custom highlight colour"
          customDefault="#fef08a"
          clearName="Clear highlight colour"
          mark="backgroundColor"
          swatches={HIGHLIGHT_SWATCHES}
          textNodes={inspection.textNodes}
          onApply={(value) => applyColour("backgroundColor", value)}
        />
      ) : null}
      {openPalette === "text" ? (
        <ColourPanel
          id={textPanelId}
          paletteName="Text colour palette"
          customName="Custom text colour"
          customDefault="#334155"
          clearName="Clear text colour"
          mark="color"
          swatches={TEXT_SWATCHES}
          textNodes={inspection.textNodes}
          onApply={(value) => applyColour("color", value)}
        />
      ) : null}
    </div>
  );
}
