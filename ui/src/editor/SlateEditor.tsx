import { useCallback, useMemo, useState } from "react";
import {
  type BasePoint,
  createEditor,
  type Descendant,
  Editor,
  Node,
  Range,
  Element as SlateElement,
  Text,
  Transforms,
} from "slate";
import { withHistory } from "slate-history";
import { Editable, Slate, withReact } from "slate-react";
import type { BlockResponse } from "#/api/blocks";
import { useAssignBlockId } from "#/api/blocks";
import { usePages } from "#/api/pages";
import {
  applyBlockConversion,
  type BlockConversion,
} from "#/editor/transforms/blockConversions";
import { matchesChord, SHORTCUTS } from "#/lib/shortcuts";
import { BlockRefCombobox } from "./BlockRefCombobox";
import { decorateCode } from "./decorate-code";
import { renderElement } from "./elements/renderElement";
import { renderLeaf } from "./elements/renderLeaf";
import { createSelectionReference } from "./floatingSelectionReference";
import { withAutoformat } from "./plugins/autoformat/withAutoformat";
import { withMarkdownPaste } from "./plugins/withMarkdownPaste";
import {
  indentListItem,
  moveBlockDown,
  moveBlockUp,
  outdentListItem,
  toggleCheckbox,
  withOutliner,
} from "./plugins/withOutliner";
import { SlashCombobox, type SlashCommand } from "./SlashCombobox";
import { makeBlockRef } from "./schema/elements/blockRef";
import { makeWikilink } from "./schema/elements/wikilink";
import { withSchema } from "./schema/withSchema";
import { useVim, VimStatusBar } from "./vim";
import { WikilinkCombobox } from "./WikilinkCombobox";

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
    default:
      return null;
  }
}

interface SlateEditorProps {
  initialValue: Descendant[];
  onChange: (value: Descendant[], editor: Editor) => void;
  onSaveNow: () => void;
}

interface ComboboxTrigger {
  anchor: BasePoint;
  query: string;
}

export function SlateEditor({
  initialValue,
  onChange,
  onSaveNow,
}: SlateEditorProps) {
  const editor = useMemo(
    () =>
      withMarkdownPaste(
        withReact(
          withHistory(withAutoformat(withOutliner(withSchema(createEditor())))),
        ),
      ),
    [],
  );

  const { data: pagesData } = usePages();
  const pages = pagesData?.items ?? [];
  const assignBlockId = useAssignBlockId();

  // Per-editor, non-persistent: each editor instance starts with vim off.
  const [isVimEnabled, setIsVimEnabled] = useState(false);
  const vim = useVim(editor, isVimEnabled);

  const [wikilinkTrigger, setWikilinkTrigger] =
    useState<ComboboxTrigger | null>(null);
  const [blockRefTrigger, setBlockRefTrigger] =
    useState<ComboboxTrigger | null>(null);
  const [slashTrigger, setSlashTrigger] = useState<ComboboxTrigger | null>(
    null,
  );

  const handleChange = (value: Descendant[]) => {
    onChange(value, editor);

    const { selection } = editor;
    if (!selection || !Range.isCollapsed(selection)) {
      setWikilinkTrigger(null);
      setBlockRefTrigger(null);
      return;
    }

    const [node] = Editor.node(editor, selection.anchor.path);
    if (!Text.isText(node)) {
      setWikilinkTrigger(null);
      setBlockRefTrigger(null);
      return;
    }

    const textBefore = node.text.slice(0, selection.anchor.offset);

    // Check for [[ wikilink trigger
    const wikiTriggerIndex = textBefore.lastIndexOf("[[");
    if (wikiTriggerIndex !== -1) {
      const afterTrigger = textBefore.slice(wikiTriggerIndex + 2);
      if (!afterTrigger.includes("]]")) {
        setWikilinkTrigger({
          anchor: { path: selection.anchor.path, offset: wikiTriggerIndex },
          query: afterTrigger,
        });
        setBlockRefTrigger(null);
        return;
      }
    }
    setWikilinkTrigger(null);

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

  const insertWikilink = (page: {
    title?: string | null;
    canonical_name: string;
  }) => {
    if (!wikilinkTrigger) return;

    const { selection } = editor;
    if (!selection) return;

    const deleteRange = {
      anchor: wikilinkTrigger.anchor,
      focus: selection.focus,
    };

    Transforms.select(editor, deleteRange);
    Transforms.delete(editor);

    const wikilinkNode = makeWikilink({
      target: page.title ?? page.canonical_name,
    });

    Transforms.insertNodes(editor, wikilinkNode);
    Transforms.move(editor);

    setWikilinkTrigger(null);
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

  const slashCommands: SlashCommand[] = useMemo(
    () => [
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
    ],
    [],
  );

  const executeSlashCommand = useCallback(
    (cmd: SlashCommand) => {
      if (!slashTrigger) return;
      const { selection } = editor;
      if (!selection) return;

      const conversion = slashCommandToConversion(cmd.id);
      if (!conversion) {
        setSlashTrigger(null);
        return;
      }

      const entry = Editor.above(editor, {
        match: (n) => SlateElement.isElement(n) && n.type === "paragraph",
      });
      if (!entry) {
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
    [slashTrigger, editor],
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
    if (wikilinkTrigger || blockRefTrigger || slashTrigger) {
      if (
        ["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)
      ) {
        event.preventDefault();
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
      onSaveNow();
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
    <div className="relative">
      <Slate
        editor={editor}
        initialValue={initialValue}
        onChange={handleChange}
      >
        <Editable
          renderElement={renderElement}
          renderLeaf={renderLeaf}
          decorate={decorateCode}
          onKeyDown={handleKeyDown}
          onDOMBeforeInput={(event) => {
            vim.handleDOMBeforeInput(event);
          }}
          onMouseDown={() => {
            vim.handleMouseDown();
          }}
          placeholder="Start writing..."
          className="min-h-[200px] outline-none"
          spellCheck
        />
        {isVimEnabled && <VimStatusBar mode={vim.mode} pending={vim.pending} />}
      </Slate>

      {wikilinkTrigger && (
        <WikilinkCombobox
          pages={pages}
          query={wikilinkTrigger.query}
          reference={createSelectionReference(editor)}
          onSelect={insertWikilink}
          onClose={() => setWikilinkTrigger(null)}
        />
      )}

      {blockRefTrigger && (
        <BlockRefCombobox
          query={blockRefTrigger.query}
          reference={createSelectionReference(editor)}
          onSelect={insertBlockRef}
          onClose={() => setBlockRefTrigger(null)}
        />
      )}

      {slashTrigger && (
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
