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
  Palette,
  Strikethrough,
  Subscript,
  Superscript,
  Underline,
  type LucideIcon,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
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
  type Editor as SlateEditor,
  Editor,
  Element as SlateElement,
  Range,
  Text,
  Transforms,
} from "slate";
import { ReactEditor, useSlate } from "slate-react";
import { IconButton } from "#/components/ui/icon-button";
import { VesselTooltip } from "#/components/ui/tooltip";
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
}

export function SelectionBubbleMenu({ readOnly }: SelectionBubbleMenuProps) {
  const editor = useSlate();
  const selection = editor.selection;
  const highlightPanelId = useId();
  const textPanelId = useId();
  const preservedRangeRef = useRef<BaseRange | null>(null);
  const previousSelectionRef = useRef<BaseRange | null>(null);
  const [openPalette, setOpenPalette] = useState<OpenPalette>(null);

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
    if (selectionChanged || !visible) setOpenPalette(null);
    previousSelectionRef.current = selection ? cloneRange(selection) : null;
  }, [selection, visible]);

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
