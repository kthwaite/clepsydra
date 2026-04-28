import type { RenderElementProps } from "slate-react";
import { useBlock } from "#/api/blocks";
import type { BlockRefElement as BlockRefElementType } from "#/editor/types";
import { useOpenTab } from "#/hooks/useOpenTab";

type Props = RenderElementProps & { element: BlockRefElementType };

export function BlockRefElement({ attributes, children, element }: Props) {
  const { data: block } = useBlock(element.blockId);
  const openTab = useOpenTab();

  const title = block
    ? `Open ${block.page_title || block.page_path}`
    : `Block reference: ${element.blockId}`;

  return (
    <span {...attributes}>
      <button
        type="button"
        contentEditable={false}
        className="inline cursor-pointer border border-border bg-muted px-1.5 text-sm italic hover:bg-accent"
        title={title}
        onClick={(e) => {
          e.preventDefault();
          if (!block) return;
          openTab("page", block.page_path, block.page_title || block.page_path);
        }}
      >
        {element.blockId}
      </button>
      {children}
    </span>
  );
}
