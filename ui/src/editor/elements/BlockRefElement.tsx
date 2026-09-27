import {
  ReactEditor,
  type RenderElementProps,
  useReadOnly,
  useSlateStatic,
} from "slate-react";
import { BlockTransclusion } from "#/components/blocks/BlockTransclusion";
import { blockRefSourceAdapter } from "#/editor/blockRefSourceAdapter";
import { InlineSourceEditor } from "#/editor/InlineSourceInput";
import {
  isSessionAt,
  useInlineSourceEditing,
} from "#/editor/inlineSourceEditing";
import type { BlockRefElement as BlockRefElementType } from "#/editor/types";
import { useOpenTab } from "#/hooks/useOpenTab";

type Props = RenderElementProps & { element: BlockRefElementType };

export function BlockRefElement({ attributes, children, element }: Props) {
  const editor = useSlateStatic();
  const readOnly = useReadOnly();
  const controller = useInlineSourceEditing();
  const openTab = useOpenTab();

  const session = controller.active;
  if (
    !readOnly &&
    session &&
    isSessionAt(session, ReactEditor.findPath(editor, element))
  ) {
    return (
      <span {...attributes}>
        <InlineSourceEditor
          adapter={blockRefSourceAdapter}
          element={element}
          session={session}
        />
        {children}
      </span>
    );
  }

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
