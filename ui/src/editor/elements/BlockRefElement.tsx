import type { RenderElementProps } from "slate-react";
import { BlockTransclusion } from "#/components/blocks/BlockTransclusion";
import type { BlockRefElement as BlockRefElementType } from "#/editor/types";
import { useOpenTab } from "#/hooks/useOpenTab";

type Props = RenderElementProps & { element: BlockRefElementType };

export function BlockRefElement({ attributes, children, element }: Props) {
  const openTab = useOpenTab();

  return (
    <span {...attributes} contentEditable={false}>
      <BlockTransclusion
        blockId={element.blockId}
        onOpenSource={(block) => {
          openTab(
            "page",
            block.page_path,
            block.page_title || block.page_path,
            { blockId: element.blockId },
          );
        }}
      />
      {children}
    </span>
  );
}
