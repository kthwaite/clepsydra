import { useCallback, useMemo, useState } from "react";
import {
  type BasePoint,
  createEditor,
  type Descendant,
  Editor,
  Node,
  Path,
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
import { BlockRefCombobox } from "./BlockRefCombobox";
import { decorateCode } from "./decorate-code";
import { renderElement } from "./elements/renderElement";
import { renderLeaf } from "./elements/renderLeaf";
import { createSelectionReference } from "./floatingSelectionReference";
import { withAutoformat } from "./plugins/autoformat/withAutoformat";
import { withLinks } from "./plugins/withLinks";
import {
  indentListItem,
  moveBlockDown,
  moveBlockUp,
  outdentListItem,
  toggleCheckbox,
  withOutliner,
} from "./plugins/withOutliner";
import { withWikilinks } from "./plugins/withWikilinks";
import { SlashCombobox, type SlashCommand } from "./SlashCombobox";
import type { BlockRefElement, WikilinkElement } from "./types";
import { WikilinkCombobox } from "./WikilinkCombobox";

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
      withReact(
        withHistory(
          withAutoformat(
            withOutliner(withLinks(withWikilinks(createEditor()))),
          ),
        ),
      ),
    [],
  );

  const { data: pagesData } = usePages();
  const pages = pagesData?.items ?? [];
  const assignBlockId = useAssignBlockId();

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
      if ((block as any).type === "paragraph") {
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

    const wikilinkNode: WikilinkElement = {
      type: "wikilink",
      target: page.title ?? page.canonical_name,
      children: [{ text: "" }],
    };

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

    const blockRefNode: BlockRefElement = {
      type: "block-ref",
      blockId,
      children: [{ text: "" }],
    };

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

      // Delete /query text
      Transforms.delete(editor, {
        at: { anchor: slashTrigger.anchor, focus: selection.focus },
      });

      // Apply transform based on command
      switch (cmd.id) {
        case "h1":
        case "h2":
        case "h3":
        case "h4":
        case "h5":
        case "h6": {
          const level = Number.parseInt(cmd.id.slice(1)) as
            | 1
            | 2
            | 3
            | 4
            | 5
            | 6;
          const entry = Editor.above(editor, {
            match: (n) =>
              SlateElement.isElement(n) && (n as any).type === "paragraph",
          });
          if (entry) {
            Transforms.setNodes(editor, { type: "heading", level } as any, {
              at: entry[1],
            });
          }
          break;
        }
        case "bullet":
        case "number": {
          const listType =
            cmd.id === "bullet" ? "bulleted-list" : "numbered-list";
          const entry = Editor.above(editor, {
            match: (n) =>
              SlateElement.isElement(n) && (n as any).type === "paragraph",
          });
          if (entry) {
            const [, blockPath] = entry;
            Transforms.setNodes(editor, { type: "list-item" } as any, {
              at: blockPath,
            });
            Transforms.wrapNodes(
              editor,
              { type: "paragraph", children: [] } as any,
              { at: blockPath, match: (n) => Text.isText(n) },
            );
            Transforms.wrapNodes(
              editor,
              { type: listType, children: [] } as any,
              { at: blockPath },
            );
          }
          break;
        }
        case "task": {
          const entry = Editor.above(editor, {
            match: (n) =>
              SlateElement.isElement(n) && (n as any).type === "paragraph",
          });
          if (entry) {
            const [, blockPath] = entry;
            Transforms.setNodes(
              editor,
              { type: "list-item", checked: false } as any,
              { at: blockPath },
            );
            Transforms.wrapNodes(
              editor,
              { type: "paragraph", children: [] } as any,
              { at: blockPath, match: (n) => Text.isText(n) },
            );
            Transforms.wrapNodes(
              editor,
              { type: "bulleted-list", children: [] } as any,
              { at: blockPath },
            );
          }
          break;
        }
        case "quote": {
          const entry = Editor.above(editor, {
            match: (n) =>
              SlateElement.isElement(n) && (n as any).type === "paragraph",
          });
          if (entry) {
            Transforms.wrapNodes(
              editor,
              { type: "blockquote", children: [] } as any,
              { at: entry[1] },
            );
          }
          break;
        }
        case "code": {
          const entry = Editor.above(editor, {
            match: (n) =>
              SlateElement.isElement(n) && (n as any).type === "paragraph",
          });
          if (entry) {
            const [, blockPath] = entry;
            Transforms.removeNodes(editor, { at: blockPath });
            Transforms.insertNodes(
              editor,
              { type: "code-block", children: [{ text: "" }] } as any,
              { at: blockPath },
            );
            Transforms.select(editor, {
              anchor: { path: [...blockPath, 0], offset: 0 },
              focus: { path: [...blockPath, 0], offset: 0 },
            });
          }
          break;
        }
        case "divider": {
          const entry = Editor.above(editor, {
            match: (n) =>
              SlateElement.isElement(n) && (n as any).type === "paragraph",
          });
          if (entry) {
            const [, blockPath] = entry;
            Transforms.removeNodes(editor, { at: blockPath });
            Transforms.insertNodes(
              editor,
              {
                type: "thematic-break",
                children: [{ text: "" }],
              } as any,
              { at: blockPath },
            );
            const nextPath = Path.next(blockPath);
            Transforms.insertNodes(
              editor,
              { type: "paragraph", children: [{ text: "" }] } as any,
              { at: nextPath },
            );
            Transforms.select(editor, {
              anchor: { path: [...nextPath, 0], offset: 0 },
              focus: { path: [...nextPath, 0], offset: 0 },
            });
          }
          break;
        }
      }
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

    // --- Outliner keybindings ---
    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      indentListItem(editor);
      return;
    }
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      outdentListItem(editor);
      return;
    }
    if (event.key === "ArrowUp" && event.altKey) {
      event.preventDefault();
      moveBlockUp(editor);
      return;
    }
    if (event.key === "ArrowDown" && event.altKey) {
      event.preventDefault();
      moveBlockDown(editor);
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      toggleCheckbox(editor);
      return;
    }

    // --- Save ---
    if ((event.metaKey || event.ctrlKey) && event.key === "s") {
      event.preventDefault();
      onSaveNow();
      return;
    }

    // --- Formatting marks ---
    if (event.metaKey || event.ctrlKey) {
      switch (event.key) {
        case "b": {
          event.preventDefault();
          const marks = Editor.marks(editor);
          if (marks?.bold) {
            Editor.removeMark(editor, "bold");
          } else {
            Editor.addMark(editor, "bold", true);
          }
          return;
        }
        case "i": {
          event.preventDefault();
          const marks = Editor.marks(editor);
          if (marks?.italic) {
            Editor.removeMark(editor, "italic");
          } else {
            Editor.addMark(editor, "italic", true);
          }
          return;
        }
        case "u": {
          event.preventDefault();
          const marks = Editor.marks(editor);
          if (marks?.underline) {
            Editor.removeMark(editor, "underline");
          } else {
            Editor.addMark(editor, "underline", true);
          }
          return;
        }
        case "e": {
          event.preventDefault();
          const marks = Editor.marks(editor);
          if (marks?.code) {
            Editor.removeMark(editor, "code");
          } else {
            Editor.addMark(editor, "code", true);
          }
          return;
        }
        case "d": {
          event.preventDefault();
          const marks = Editor.marks(editor);
          if (marks?.strikethrough) {
            Editor.removeMark(editor, "strikethrough");
          } else {
            Editor.addMark(editor, "strikethrough", true);
          }
          return;
        }
      }
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
          placeholder="Start writing..."
          className="min-h-[200px] outline-none"
          spellCheck
        />
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
