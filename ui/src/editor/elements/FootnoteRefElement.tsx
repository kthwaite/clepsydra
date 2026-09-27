import { useState } from "react";
import { Node } from "slate";
import {
  ReactEditor,
  type RenderElementProps,
  useReadOnly,
  useSlateStatic,
} from "slate-react";
import { footnoteRefSourceAdapter } from "#/editor/footnoteRefSourceAdapter";
import { InlineSourceEditor } from "#/editor/InlineSourceInput";
import {
  isSessionAt,
  useInlineSourceEditing,
} from "#/editor/inlineSourceEditing";
import type { FootnoteRefElement as FootnoteRefElementType } from "#/editor/types";

type Props = RenderElementProps & { element: FootnoteRefElementType };

export function FootnoteRefElement({ attributes, children, element }: Props) {
  const editor = useSlateStatic();
  const readOnly = useReadOnly();
  const controller = useInlineSourceEditing();
  const [hover, setHover] = useState(false);

  const session = controller.active;
  if (
    !readOnly &&
    session &&
    isSessionAt(session, ReactEditor.findPath(editor, element))
  ) {
    return (
      <span {...attributes}>
        <InlineSourceEditor
          adapter={footnoteRefSourceAdapter}
          element={element}
          session={session}
        />
        {children}
      </span>
    );
  }

  // Resolve the matching footnote-def's text locally from the editor tree.
  // Only walk on hover — avoids an O(doc) traversal per ref on every render.
  let preview = "";
  if (hover) {
    for (const [node] of Node.elements(editor)) {
      if (
        node.type === "footnote-def" &&
        node.identifier === element.identifier
      ) {
        preview = Node.string(node);
        break;
      }
    }
  }

  return (
    <span {...attributes}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Hover only reveals a noninteractive preview; this reference has no navigation target. */}
      <span
        contentEditable={false}
        className="relative inline cursor-default pl-0.5 align-super text-[0.75em] tabular-nums text-accent"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        [{element.identifier}]
        {hover && preview && (
          <span className="absolute left-0 top-full z-40 mt-1.5 block w-[280px] cursor-default rounded-[16px] bg-raise px-4 py-3 text-left align-baseline text-[13.5px] font-normal not-italic leading-[1.55] text-ink-2 shadow-lg">
            {preview.slice(0, 240)}
            {preview.length > 240 ? "…" : ""}
          </span>
        )}
      </span>
      {children}
    </span>
  );
}
