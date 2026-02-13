import { useCallback, useMemo, useState } from "react";
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
import { Editable, ReactEditor, Slate, withReact } from "slate-react";
import { usePages } from "#/api/pages";
import { renderElement } from "./elements/renderElement";
import { renderLeaf } from "./elements/renderLeaf";
import { withLinks } from "./plugins/withLinks";
import { withWikilinks } from "./plugins/withWikilinks";
import type { WikilinkElement } from "./types";
import { WikilinkCombobox } from "./WikilinkCombobox";
import "./types";

interface SlateEditorProps {
  initialValue: Descendant[];
  onChange: (value: Descendant[]) => void;
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
  const [comboboxPosition, setComboboxPosition] = useState({
    top: 0,
    left: 0,
  });

  const updateComboboxPosition = useCallback(() => {
    const { selection } = editor;
    if (!selection || !Range.isCollapsed(selection)) return;
    try {
      const domRange = ReactEditor.toDOMRange(editor, selection);
      const rect = domRange.getBoundingClientRect();
      setComboboxPosition({
        top: rect.bottom + 4,
        left: rect.left,
      });
    } catch {
      // DOM range may not exist during initialization
    }
  }, [editor]);

  const handleChange = useCallback(
    (value: Descendant[]) => {
      onChange(value);

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
      updateComboboxPosition();
    },
    [editor, onChange, updateComboboxPosition],
  );

  const insertWikilink = useCallback(
    (page: { title?: string | null; canonical_name: string }) => {
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
    },
    [editor, wikilinkTrigger],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (wikilinkTrigger) {
        if (["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) {
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
    },
    [editor, onSaveNow, wikilinkTrigger],
  );

  const memoRenderElement = useCallback(renderElement, []);
  const memoRenderLeaf = useCallback(renderLeaf, []);

  return (
    <div className="relative">
      <Slate
        editor={editor}
        initialValue={initialValue}
        onChange={handleChange}
      >
        <Editable
          renderElement={memoRenderElement}
          renderLeaf={memoRenderLeaf}
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
          position={comboboxPosition}
          onSelect={insertWikilink}
          onClose={() => setWikilinkTrigger(null)}
        />
      )}
    </div>
  );
}
