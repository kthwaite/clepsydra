import { useState } from "react";
import { Node } from "slate";
import { type RenderElementProps, useSlateStatic } from "slate-react";
import type { FootnoteRefElement as FootnoteRefElementType } from "#/editor/types";

type Props = RenderElementProps & { element: FootnoteRefElementType };

export function FootnoteRefElement({ attributes, children, element }: Props) {
  const editor = useSlateStatic();
  const [hover, setHover] = useState(false);

  // Resolve the matching footnote-def's text locally from the editor tree.
  let preview = "";
  for (const [node] of Node.elements(editor)) {
    if (
      (node as any).type === "footnote-def" &&
      (node as any).identifier === element.identifier
    ) {
      preview = Node.string(node);
      break;
    }
  }

  return (
    <span {...attributes}>
      <span
        contentEditable={false}
        className="relative inline cursor-default align-super text-[0.75em] text-accent"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        [{element.identifier}]
        {hover && preview && (
          <span className="absolute left-0 top-full z-40 mt-1 block w-[280px] cursor-default border border-ink bg-paper px-2 py-1.5 text-left align-baseline text-[11px] not-italic leading-[1.4] text-ink shadow-[3px_3px_0_0_var(--color-ink)]">
            {preview.slice(0, 240)}
            {preview.length > 240 ? "…" : ""}
          </span>
        )}
      </span>
      {children}
    </span>
  );
}
