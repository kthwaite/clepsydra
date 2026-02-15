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
import { usePages } from "#/api/pages";
import { renderElement } from "./elements/renderElement";
import { renderLeaf } from "./elements/renderLeaf";
import { createSelectionReference } from "./floatingSelectionReference";
import { withLinks } from "./plugins/withLinks";
import { withWikilinks } from "./plugins/withWikilinks";
import type { WikilinkElement } from "./types";
import { WikilinkCombobox } from "./WikilinkCombobox";

interface SlateEditorProps {
  initialValue: Descendant[];
  onChange: (value: Descendant[], editor: Editor) => void;
  onSaveNow: () => void;
}

interface WikilinkTrigger {
  anchor: BasePoint;
  query: string;
}

export function SlateEditor({
  initialValue,
  onChange,
  onSaveNow,
}: SlateEditorProps) {
  const editor = useMemo(
    () => withReact(withHistory(withLinks(withWikilinks(createEditor())))),
    [],
  );

  const { data: pagesData } = usePages();
  const pages = pagesData?.items ?? [];

  const [wikilinkTrigger, setWikilinkTrigger] =
    useState<WikilinkTrigger | null>(null);

  const handleChange = (value: Descendant[]) => {
    onChange(value, editor);

    const { selection } = editor;
    if (!selection || !Range.isCollapsed(selection)) {
      setWikilinkTrigger(null);
      return;
    }

    const [node] = Editor.node(editor, selection.anchor.path);
    if (!Text.isText(node)) {
      setWikilinkTrigger(null);
      return;
    }

    const textBefore = node.text.slice(0, selection.anchor.offset);
    const triggerIndex = textBefore.lastIndexOf("[[");

    if (triggerIndex === -1) {
      setWikilinkTrigger(null);
      return;
    }

    const afterTrigger = textBefore.slice(triggerIndex + 2);
    if (afterTrigger.includes("]]")) {
      setWikilinkTrigger(null);
      return;
    }

    const query = afterTrigger;
    const anchor: BasePoint = {
      path: selection.anchor.path,
      offset: triggerIndex,
    };

    setWikilinkTrigger({ anchor, query });
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

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (wikilinkTrigger) {
      if (["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) {
        event.preventDefault();
        return;
      }
    }

    if ((event.metaKey || event.ctrlKey) && event.key === "s") {
      event.preventDefault();
      onSaveNow();
      return;
    }

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
    </div>
  );
}
