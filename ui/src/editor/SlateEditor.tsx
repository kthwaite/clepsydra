import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type BasePoint,
  createEditor,
  type Descendant,
  Editor,
  Node,
  Point,
  Range,
  type RangeRef,
  Element as SlateElement,
  Text,
  Transforms,
} from "slate";
import { withHistory } from "slate-history";
import { Editable, ReactEditor, Slate, withReact } from "slate-react";
import type { BlockResponse } from "#/api/blocks";
import { useAssignBlockId } from "#/api/blocks";
import { usePages } from "#/api/pages";
import {
  applyBlockConversion,
  type BlockConversion,
} from "#/editor/transforms/blockConversions";
import type { CustomEditor } from "#/editor/types";
import { useResolveOrCreateWikilinkTarget } from "#/editor/useResolveOrCreateWikilinkTarget";
import { matchesChord, SHORTCUTS } from "#/lib/shortcuts";
import { BlockRefCombobox } from "./BlockRefCombobox";
import {
  BaseEmbedEditingProvider,
  useBaseEmbedEditingController,
} from "./baseEmbedEditing";
import { makeDecorateCode } from "./decorate-code";
import { renderElement } from "./elements/renderElement";
import { renderLeaf } from "./elements/renderLeaf";
import { createSelectionReference } from "./floatingSelectionReference";
import { MathEditingProvider, useMathEditingController } from "./mathEditing";
import { withAutoformat } from "./plugins/autoformat/withAutoformat";
import {
  exitTerminalInlineCode,
  withInlinePunctuationBoundary,
} from "./plugins/withInlinePunctuationBoundary";
import { withMarkdownPaste } from "./plugins/withMarkdownPaste";
import { withMathClipboard } from "./plugins/withMathClipboard";
import {
  indentListItem,
  moveBlockDown,
  moveBlockUp,
  outdentListItem,
  toggleCheckbox,
  withOutliner,
} from "./plugins/withOutliner";
import { useRefractor } from "./refractor-lazy";
import { SlashCombobox, type SlashCommand } from "./SlashCombobox";
import { makeBaseEmbed } from "./schema/elements/baseEmbed";
import { makeBlockRef } from "./schema/elements/blockRef";
import { makeWikilink } from "./schema/elements/wikilink";
import { withSchema } from "./schema/withSchema";
import {
  TaskPropertyPopover,
  taskItemAtSelection,
  useTaskPropertyPopoverController,
} from "./TaskPropertyPopover";
import { TaskPropertyPopoverProvider } from "./taskPropertyContext";
import { insertMarkdown } from "./transforms/insertMarkdown";
import {
  handleJournalTimeHeadingDeletion,
  insertJournalTimeHeading,
} from "./transforms/journalTime";
import { useVim, VimStatusBar } from "./vim";
import { WikilinkCombobox } from "./WikilinkCombobox";
import {
  findAdjacentWikilink,
  useWikilinkEditingController,
  WikilinkEditingProvider,
} from "./wikilinkEditing";

export function slashCommandToConversion(id: string): BlockConversion | null {
  switch (id) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return {
        type: "heading",
        level: Number.parseInt(id.slice(1), 10) as 1 | 2 | 3 | 4 | 5 | 6,
      };
    case "bullet":
      return { type: "bulleted-list" };
    case "number":
      return { type: "numbered-list" };
    case "task":
      return { type: "task" };
    case "quote":
      return { type: "blockquote" };
    case "code":
      return { type: "code-block" };
    case "divider":
      return { type: "thematic-break" };
    case "time":
      return { type: "journal-time" };
    default:
      return null;
  }
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "time",
    label: "Time Heading",
    description: "Insert the current local time as a section heading",
  },
  {
    id: "base",
    label: "Base embed",
    description: "Insert a live saved Base view",
  },
  { id: "h1", label: "Heading 1", description: "Large heading" },
  { id: "h2", label: "Heading 2", description: "Medium heading" },
  { id: "h3", label: "Heading 3", description: "Small heading" },
  { id: "h4", label: "Heading 4", description: "Smaller heading" },
  { id: "h5", label: "Heading 5", description: "Tiny heading" },
  { id: "h6", label: "Heading 6", description: "Smallest heading" },
  { id: "bullet", label: "Bullet list", description: "Unordered list" },
  { id: "number", label: "Numbered list", description: "Ordered list" },
  { id: "task", label: "Task list", description: "Checklist item" },
  { id: "quote", label: "Blockquote", description: "Quoted text" },
  { id: "code", label: "Code block", description: "Code snippet" },
  { id: "divider", label: "Divider", description: "Horizontal rule" },
];

export interface SlateEditorProps {
  initialValue: Descendant[];
  onChange: (value: Descendant[], editor: Editor) => void;
  onSaveNow: () => void | Promise<void>;
  insertionRequest?: { id: number; markdown: string } | null;
  onInsertionHandled?: (id: number) => void;
  readOnly?: boolean;
  editorRef?: RefObject<CustomEditor | null>;
  /** Called with the live editor instance as this component unmounts, while
   *  its selection and focus bookkeeping are still intact. Lets the owner
   *  snapshot caret state across an in-place (key-swap) remount. */
  onUnmountSnapshot?: (editor: CustomEditor) => void;
}

interface ComboboxTrigger {
  anchor: BasePoint;
  query: string;
}

interface WikilinkCreateRequest {
  trigger: ComboboxTrigger;
}

export function SlateEditor({
  initialValue,
  onChange,
  onSaveNow,
  insertionRequest,
  onInsertionHandled,
  readOnly = false,
  editorRef,
  onUnmountSnapshot,
}: SlateEditorProps) {
  const editor = useMemo(
    () =>
      withMathClipboard(
        withMarkdownPaste(
          withReact(
            withInlinePunctuationBoundary(
              withHistory(
                withAutoformat(withOutliner(withSchema(createEditor()))),
              ),
            ),
          ),
        ),
      ),
    [],
  );
  if (editorRef) editorRef.current = editor;

  useEffect(() => {
    if (editorRef) editorRef.current = editor;
    return () => {
      if (editorRef?.current === editor) editorRef.current = null;
    };
  }, [editor, editorRef]);

  // Latest-callback ref so the unmount snapshot fires exactly once, at real
  // unmount. A layout effect keeps it in the mutation phase, before the
  // replacement instance's layout effects (and any restore keyed on them).
  const onUnmountSnapshotRef = useRef(onUnmountSnapshot);
  onUnmountSnapshotRef.current = onUnmountSnapshot;
  useLayoutEffect(
    () => () => {
      onUnmountSnapshotRef.current?.(editor);
    },
    [editor],
  );
  const wikilinkEditing = useWikilinkEditingController(editor);
  const mathEditing = useMathEditingController(editor);
  const baseEmbedEditing = useBaseEmbedEditingController(editor);
  const taskProperties = useTaskPropertyPopoverController(editor);
  const handledInsertionRef = useRef<number | null>(null);

  useEffect(() => {
    if (
      readOnly ||
      !insertionRequest ||
      handledInsertionRef.current === insertionRequest.id
    ) {
      return;
    }
    handledInsertionRef.current = insertionRequest.id;
    insertMarkdown(editor, insertionRequest.markdown);
    ReactEditor.focus(editor);
    onInsertionHandled?.(insertionRequest.id);
  }, [editor, insertionRequest, onInsertionHandled, readOnly]);

  const { data: pagesData } = usePages();
  const pages = pagesData?.items ?? [];
  const assignBlockId = useAssignBlockId();
  const { resolveOrCreate } = useResolveOrCreateWikilinkTarget();

  // Grammars load lazily on the first decorate pass over a highlighted code
  // block; the fresh decorate identity when they land re-runs decorations.
  const highlighter = useRefractor();
  const decorateCode = useMemo(
    () => makeDecorateCode(highlighter),
    [highlighter],
  );

  // Per-editor, non-persistent: each editor instance starts with vim off.
  const [isVimEnabled, setIsVimEnabled] = useState(false);
  const vim = useVim(editor, isVimEnabled);

  const [wikilinkTrigger, setWikilinkTrigger] =
    useState<ComboboxTrigger | null>(null);
  const wikilinkTriggerRef = useRef<ComboboxTrigger | null>(null);
  const wikilinkCreateRequestRef = useRef<WikilinkCreateRequest | null>(null);
  const [wikilinkCreateRequest, setWikilinkCreateRequest] =
    useState<WikilinkCreateRequest | null>(null);
  const [wikilinkCreateError, setWikilinkCreateError] = useState<string | null>(
    null,
  );
  const [blockRefTrigger, setBlockRefTrigger] =
    useState<ComboboxTrigger | null>(null);
  const [slashTrigger, setSlashTrigger] = useState<ComboboxTrigger | null>(
    null,
  );

  const updateWikilinkTrigger = (next: ComboboxTrigger | null) => {
    const previous = wikilinkTriggerRef.current;
    const triggerChanged =
      previous === null
        ? next !== null
        : next === null ||
          previous.query !== next.query ||
          !Point.equals(previous.anchor, next.anchor);
    const activeTrigger = triggerChanged ? next : previous;
    wikilinkTriggerRef.current = activeTrigger;
    setWikilinkTrigger(activeTrigger);
    if (triggerChanged) setWikilinkCreateError(null);
  };

  const handleChange = (value: Descendant[]) => {
    if (readOnly) return;
    onChange(value, editor);

    const { selection } = editor;
    if (!selection || !Range.isCollapsed(selection)) {
      updateWikilinkTrigger(null);
      setBlockRefTrigger(null);
      return;
    }

    const [node] = Editor.node(editor, selection.anchor.path);
    if (!Text.isText(node)) {
      updateWikilinkTrigger(null);
      setBlockRefTrigger(null);
      return;
    }

    const textBefore = node.text.slice(0, selection.anchor.offset);

    // Check for [[ wikilink trigger
    const wikiTriggerIndex = textBefore.lastIndexOf("[[");
    if (wikiTriggerIndex !== -1) {
      const afterTrigger = textBefore.slice(wikiTriggerIndex + 2);
      if (!afterTrigger.includes("]]")) {
        updateWikilinkTrigger({
          anchor: { path: selection.anchor.path, offset: wikiTriggerIndex },
          query: afterTrigger,
        });
        setBlockRefTrigger(null);
        return;
      }
    }
    updateWikilinkTrigger(null);

    // Check for (( block ref trigger
    const blockRefTriggerIndex = textBefore.lastIndexOf("((");
    if (blockRefTriggerIndex !== -1) {
      const afterTrigger = textBefore.slice(blockRefTriggerIndex + 2);
      if (!afterTrigger.includes("))")) {
        setBlockRefTrigger({
          anchor: {
            path: selection.anchor.path,
            offset: blockRefTriggerIndex,
          },
          query: afterTrigger,
        });
        return;
      }
    }
    setBlockRefTrigger(null);

    // Slash trigger detection (combobox exclusivity)
    const blockEntry = Editor.above(editor, {
      match: (n) => SlateElement.isElement(n) && !Editor.isEditor(n),
    });
    if (blockEntry) {
      const [block] = blockEntry;
      if (SlateElement.isElement(block) && block.type === "paragraph") {
        const fullText = Node.string(block);
        if (
          textBefore.startsWith("/") &&
          textBefore === fullText &&
          selection.anchor.offset === fullText.length
        ) {
          setSlashTrigger({
            anchor: { path: selection.anchor.path, offset: 0 },
            query: textBefore.slice(1),
          });
          return;
        }
      }
    }
    setSlashTrigger(null);
  };

  const insertWikilinkTarget = (
    target: string,
    trigger: ComboboxTrigger | null = wikilinkTrigger,
  ) => {
    if (!trigger || !editor.selection) return;
    const deleteRange = {
      anchor: trigger.anchor,
      focus: editor.selection.focus,
    };
    Transforms.select(editor, deleteRange);
    Transforms.delete(editor);
    Transforms.insertNodes(editor, makeWikilink({ target }));
    Transforms.move(editor);
    updateWikilinkTrigger(null);
  };

  const insertWikilink = (page: {
    title?: string | null;
    canonical_name: string;
  }) => insertWikilinkTarget(page.title ?? page.canonical_name);

  const createWikilinkTarget = async (title: string) => {
    const trigger = wikilinkTriggerRef.current;
    if (!trigger || wikilinkCreateRequestRef.current?.trigger === trigger) {
      return;
    }
    const request = { trigger };
    wikilinkCreateRequestRef.current = request;
    setWikilinkCreateRequest(request);
    setWikilinkCreateError(null);
    try {
      const result = await resolveOrCreate(title);
      if (
        wikilinkCreateRequestRef.current !== request ||
        wikilinkTriggerRef.current !== trigger
      ) {
        return;
      }
      insertWikilinkTarget(result.title, trigger);
    } catch {
      if (
        wikilinkCreateRequestRef.current === request &&
        wikilinkTriggerRef.current === trigger
      ) {
        setWikilinkCreateError("Creation failed — press Enter to retry");
      }
    } finally {
      if (wikilinkCreateRequestRef.current === request) {
        wikilinkCreateRequestRef.current = null;
        setWikilinkCreateRequest(null);
      }
    }
  };

  const doInsertBlockRef = (blockId: string) => {
    if (!blockRefTrigger) return;

    const { selection } = editor;
    if (!selection) return;

    const deleteRange = {
      anchor: blockRefTrigger.anchor,
      focus: selection.focus,
    };

    Transforms.select(editor, deleteRange);
    Transforms.delete(editor);

    const blockRefNode = makeBlockRef({ blockId });

    Transforms.insertNodes(editor, blockRefNode);
    Transforms.move(editor);

    setBlockRefTrigger(null);
  };

  const insertBlockRef = (block: BlockResponse) => {
    if (block.block_id) {
      doInsertBlockRef(block.block_id);
    } else {
      // Block has no ID yet — assign one first
      assignBlockId.mutate(
        { page_path: block.page_path, span_start: block.span_start },
        {
          onSuccess: (result) => {
            doInsertBlockRef(result.block_id);
          },
        },
      );
    }
  };

  const slashCommands = SLASH_COMMANDS;

  const executeSlashCommand = useCallback(
    (cmd: SlashCommand) => {
      if (!slashTrigger) return;
      const { selection } = editor;
      if (!selection) return;

      const entry = Editor.above(editor, {
        match: (node) =>
          SlateElement.isElement(node) && node.type === "paragraph",
      });
      if (!entry) {
        setSlashTrigger(null);
        return;
      }

      if (cmd.id === "base") {
        let bookmark: RangeRef | undefined;
        const node = makeBaseEmbed();
        Editor.withoutNormalizing(editor, () => {
          Transforms.delete(editor, {
            at: { anchor: slashTrigger.anchor, focus: selection.focus },
          });
          if (editor.selection) {
            bookmark = Editor.rangeRef(editor, editor.selection, {
              affinity: "forward",
            });
          }
          Transforms.insertNodes(editor, node, {
            at: entry[1],
            voids: true,
          });
          Transforms.select(editor, entry[1]);
        });
        baseEmbedEditing.begin(entry[1], {
          ...(bookmark ? { insertionBookmark: bookmark } : {}),
        });
        setSlashTrigger(null);
        return;
      }

      const conversion = slashCommandToConversion(cmd.id);
      if (!conversion) {
        setSlashTrigger(null);
        return;
      }

      applyBlockConversion(editor, {
        at: entry[1],
        deleteRange: { anchor: slashTrigger.anchor, focus: selection.focus },
        conversion,
      });
      setSlashTrigger(null);
    },
    [baseEmbedEditing, slashTrigger, editor],
  );

  const dismissSlash = useCallback(() => {
    if (!slashTrigger) return;
    const { selection } = editor;
    if (selection) {
      Transforms.delete(editor, {
        at: { anchor: slashTrigger.anchor, focus: selection.focus },
      });
    }
    setSlashTrigger(null);
  }, [slashTrigger, editor]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (wikilinkTrigger || blockRefTrigger || slashTrigger) {
      if (
        ["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)
      ) {
        event.preventDefault();
        return;
      }
    }

    if ((event.key === "Enter" || event.key === "F2") && editor.selection) {
      const selectedBase = Editor.above(editor, {
        at: editor.selection,
        match: (node) =>
          SlateElement.isElement(node) && node.type === "base-embed",
        mode: "lowest",
        voids: true,
      });
      if (selectedBase && !ReactEditor.isFocused(editor)) {
        return true;
      }
      if (selectedBase) {
        event.preventDefault();
        baseEmbedEditing.focusEntry(selectedBase[1]);
        return;
      }
    }

    if (
      (event.key === "Backspace" || event.key === "Delete") &&
      editor.selection
    ) {
      const selectedBase = Editor.above(editor, {
        at: editor.selection,
        match: (node) =>
          SlateElement.isElement(node) && node.type === "base-embed",
        mode: "lowest",
        voids: true,
      });
      if (selectedBase && !ReactEditor.isFocused(editor)) {
        return true;
      }
      if (selectedBase) {
        event.preventDefault();
        baseEmbedEditing.remove(selectedBase[1], selectedBase[0]);
        return;
      }
    }

    if (event.key === "Enter" && editor.selection) {
      const selectedMath = Editor.above(editor, {
        at: editor.selection,
        match: (node) =>
          SlateElement.isElement(node) &&
          (node.type === "inline-math" || node.type === "math-block"),
        mode: "lowest",
        voids: true,
      });
      if (selectedMath) {
        event.preventDefault();
        mathEditing.begin(selectedMath[1]);
        return;
      }
    }

    // Only a task item claims this chord; anywhere else the event is left
    // untouched rather than silently swallowed.
    if (matchesChord(event, SHORTCUTS["editor.taskProperties"].chord)) {
      const taskItem = taskItemAtSelection(editor);
      if (taskItem) {
        event.preventDefault();
        taskProperties.opener.openForPath(
          taskItem[1],
          ReactEditor.toDOMNode(editor, taskItem[0]),
        );
        return;
      }
    }

    // --- Vim mode (after popovers, before app chords) ---
    if (matchesChord(event, SHORTCUTS["editor.vimMode"].chord)) {
      event.preventDefault();
      setIsVimEnabled((enabled) => !enabled);
      return;
    }
    if (vim.handleKeyDown(event)) {
      return;
    }
    if (event.key === "ArrowRight" && exitTerminalInlineCode(editor)) {
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const adjacent = findAdjacentWikilink(editor, event.key);
      if (adjacent) {
        event.preventDefault();
        wikilinkEditing.begin(
          adjacent.path,
          adjacent.caret,
          adjacent.returnSide,
        );
        return;
      }
    }

    if (matchesChord(event, SHORTCUTS["editor.timeHeading"].chord)) {
      event.preventDefault();
      insertJournalTimeHeading(editor);
      return;
    }
    if (
      (event.key === "Backspace" || event.key === "Delete") &&
      handleJournalTimeHeadingDeletion(
        editor,
        event.key === "Backspace" ? "backward" : "forward",
      )
    ) {
      event.preventDefault();
      return;
    }

    // --- Outliner keybindings ---
    if (matchesChord(event, SHORTCUTS["editor.indent"].chord)) {
      event.preventDefault();
      indentListItem(editor);
      return;
    }
    if (matchesChord(event, SHORTCUTS["editor.outdent"].chord)) {
      event.preventDefault();
      outdentListItem(editor);
      return;
    }
    if (matchesChord(event, SHORTCUTS["editor.moveUp"].chord)) {
      event.preventDefault();
      moveBlockUp(editor);
      return;
    }
    if (matchesChord(event, SHORTCUTS["editor.moveDown"].chord)) {
      event.preventDefault();
      moveBlockDown(editor);
      return;
    }
    if (matchesChord(event, SHORTCUTS["editor.checkbox"].chord)) {
      event.preventDefault();
      toggleCheckbox(editor);
      return;
    }

    // --- Save ---
    if (matchesChord(event, SHORTCUTS["folio.save"].chord)) {
      event.preventDefault();
      void Promise.resolve(onSaveNow()).catch(() => undefined);
      return;
    }

    // --- Formatting marks ---
    if (matchesChord(event, SHORTCUTS["editor.mark.bold"].chord)) {
      event.preventDefault();
      const marks = Editor.marks(editor);
      if (marks?.bold) {
        Editor.removeMark(editor, "bold");
      } else {
        Editor.addMark(editor, "bold", true);
      }
      return;
    }
    if (matchesChord(event, SHORTCUTS["editor.mark.italic"].chord)) {
      event.preventDefault();
      const marks = Editor.marks(editor);
      if (marks?.italic) {
        Editor.removeMark(editor, "italic");
      } else {
        Editor.addMark(editor, "italic", true);
      }
      return;
    }
    if (matchesChord(event, SHORTCUTS["editor.mark.underline"].chord)) {
      event.preventDefault();
      const marks = Editor.marks(editor);
      if (marks?.underline) {
        Editor.removeMark(editor, "underline");
      } else {
        Editor.addMark(editor, "underline", true);
      }
      return;
    }
    if (matchesChord(event, SHORTCUTS["editor.mark.code"].chord)) {
      event.preventDefault();
      const marks = Editor.marks(editor);
      if (marks?.code) {
        Editor.removeMark(editor, "code");
      } else {
        Editor.addMark(editor, "code", true);
      }
      return;
    }
    if (matchesChord(event, SHORTCUTS["editor.mark.strikethrough"].chord)) {
      event.preventDefault();
      const marks = Editor.marks(editor);
      if (marks?.strikethrough) {
        Editor.removeMark(editor, "strikethrough");
      } else {
        Editor.addMark(editor, "strikethrough", true);
      }
      return;
    }
    if (matchesChord(event, SHORTCUTS["editor.mark.superscript"].chord)) {
      event.preventDefault();
      const marks = Editor.marks(editor);
      if (marks?.superscript) {
        Editor.removeMark(editor, "superscript");
      } else {
        Editor.removeMark(editor, "subscript");
        Editor.addMark(editor, "superscript", true);
      }
      return;
    }
    if (matchesChord(event, SHORTCUTS["editor.mark.subscript"].chord)) {
      event.preventDefault();
      const marks = Editor.marks(editor);
      if (marks?.subscript) {
        Editor.removeMark(editor, "subscript");
      } else {
        Editor.removeMark(editor, "superscript");
        Editor.addMark(editor, "subscript", true);
      }
      return;
    }
  };

  return (
    <div className="relative w-full min-w-0 max-md:[&>div.fixed]:max-w-[calc(100vw-24px)] max-md:[&>div.fixed_[role=option]]:flex max-md:[&>div.fixed_[role=option]]:min-h-11 max-md:[&>div.fixed_[role=option]]:items-center max-md:[&_button]:min-h-11">
      <Slate
        editor={editor}
        initialValue={initialValue}
        onChange={handleChange}
      >
        <BaseEmbedEditingProvider value={baseEmbedEditing}>
          <MathEditingProvider value={mathEditing}>
            <WikilinkEditingProvider value={wikilinkEditing}>
              <TaskPropertyPopoverProvider value={taskProperties.opener}>
                <Editable
                  data-folio-heading-root
                  renderElement={renderElement}
                  renderLeaf={renderLeaf}
                  decorate={decorateCode}
                  readOnly={readOnly}
                  onKeyDown={readOnly ? undefined : handleKeyDown}
                  onDOMBeforeInput={
                    readOnly ? undefined : vim.handleDOMBeforeInput
                  }
                  onMouseDown={readOnly ? undefined : vim.handleMouseDown}
                  placeholder="Start writing..."
                  className="min-h-[200px] w-full min-w-0 outline-none"
                  spellCheck
                />
              </TaskPropertyPopoverProvider>
              {!readOnly && isVimEnabled && (
                <VimStatusBar mode={vim.mode} pending={vim.pending} />
              )}
            </WikilinkEditingProvider>
          </MathEditingProvider>
        </BaseEmbedEditingProvider>
      </Slate>

      {!readOnly && wikilinkTrigger && (
        <WikilinkCombobox
          pages={pages}
          query={wikilinkTrigger.query}
          reference={createSelectionReference(editor)}
          onSelect={insertWikilink}
          onCreate={(title) => void createWikilinkTarget(title)}
          onClose={() => updateWikilinkTrigger(null)}
          isCreating={wikilinkCreateRequest?.trigger === wikilinkTrigger}
          createError={wikilinkCreateError}
        />
      )}

      {!readOnly && blockRefTrigger && (
        <BlockRefCombobox
          query={blockRefTrigger.query}
          reference={createSelectionReference(editor)}
          onSelect={insertBlockRef}
          onClose={() => setBlockRefTrigger(null)}
        />
      )}

      {!readOnly && taskProperties.session && (
        <TaskPropertyPopover
          key={taskProperties.session.id}
          anchor={taskProperties.session.anchor}
          initial={taskProperties.session.initial}
          onCommit={taskProperties.commit}
          onDiscard={taskProperties.discard}
        />
      )}

      {!readOnly && slashTrigger && (
        <SlashCombobox
          commands={slashCommands}
          query={slashTrigger.query}
          reference={createSelectionReference(editor)}
          onSelect={executeSlashCommand}
          onClose={dismissSlash}
        />
      )}
    </div>
  );
}
