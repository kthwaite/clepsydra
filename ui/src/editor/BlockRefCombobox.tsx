import type { VirtualElement } from "@floating-ui/react";
import type { BlockResponse } from "#/api/blocks";
import { useSearchBlocks } from "#/api/blocks";
import { EditorSuggestionPopover } from "#/components/ui/editor-suggestion-popover";

interface BlockRefComboboxProps {
  query: string;
  reference: VirtualElement | null;
  onSelect: (block: BlockResponse) => void;
  onClose: () => void;
}

export function BlockRefCombobox({
  query,
  reference,
  onSelect,
  onClose,
}: BlockRefComboboxProps) {
  const { data: blocks = [], isLoading } = useSearchBlocks(query);

  return (
    <EditorSuggestionPopover
      items={blocks}
      query={query}
      reference={reference}
      onSelect={onSelect}
      onClose={onClose}
      getItemKey={(b) => `${b.page_path}:${b.span_start}`}
      isLoading={isLoading && query.length >= 2}
      emptyMessage={
        query.length < 2 ? "Type to search blocks..." : "No blocks found"
      }
      renderItem={(block) => (
        <>
          <div className="truncate font-medium">{block.content}</div>
          <div className="text-xs text-muted-foreground">
            {block.page_title ?? block.page_path}
            {block.block_id ? (
              <span className="ml-1 opacity-50">^{block.block_id}</span>
            ) : (
              <span className="ml-1 italic opacity-50">no id</span>
            )}
          </div>
        </>
      )}
    />
  );
}
