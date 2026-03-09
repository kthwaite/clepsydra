import { useMemo, useState } from "react";
import {
  type BasePoint,
  createEditor,
  type Descendant,
  Editor,
  Range,
  Text,
  Transforms,
} from "slate";
import { withHistory } from "slate-history";
import { Editable, Slate, withReact } from "slate-react";
import type { BlockResponse } from "#/api/blocks";
import { useAssignBlockId } from "#/api/blocks";
import { usePages } from "#/api/pages";
import { BlockRefCombobox } from "./BlockRefCombobox";
import { renderElement } from "./elements/renderElement";
import { renderLeaf } from "./elements/renderLeaf";
import { createSelectionReference } from "./floatingSelectionReference";
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
        withHistory(withOutliner(withLinks(withWikilinks(createEditor())))),
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

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (wikilinkTrigger || blockRefTrigger) {
      if (["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) {
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
    </div>
  );
}
