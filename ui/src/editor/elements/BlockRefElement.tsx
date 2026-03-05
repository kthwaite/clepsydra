import type { RenderElementProps } from "slate-react";
import type { BlockRefElement as BlockRefElementType } from "#/editor/types";

type Props = RenderElementProps & { element: BlockRefElementType };

export function BlockRefElement({ attributes, children, element }: Props) {
  return (
    <span {...attributes}>
      <span
        contentEditable={false}
        className="inline cursor-pointer border border-border bg-muted px-1.5 text-sm italic hover:bg-accent"
        onClick={(e) => {
          e.preventDefault();
        }}
      >
        {element.blockId}
      </span>
      {children}
    </span>
  );
}
