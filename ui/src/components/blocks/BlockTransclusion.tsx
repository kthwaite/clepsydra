import { useBlock } from "#/api/blocks";
import type { BlockResponse } from "#/api/blocks";
import { cn } from "#/lib/cn";

export interface BlockTransclusionProps {
  blockId: string;
  onOpenSource: (block: BlockResponse) => void;
  className?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeCodeFence(content: string): string {
  const opening = content.match(/^(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/);
  if (!opening) return content;

  const fence = opening[1];
  const closing = new RegExp(
    `(?:\\r?\\n)?${escapeRegExp(fence)}[ \\t]*$`,
  );
  return content.slice(opening[0].length).replace(closing, "");
}

export function blockDisplayContent(block: BlockResponse): string {
  const removeTerminalId = (content: string) => {
    if (!block.block_id) return content;
    const terminalId = new RegExp(
      `(?:^|[ \\t]+)\\^${escapeRegExp(block.block_id)}[ \\t]*$`,
    );
    return content.replace(terminalId, "");
  };

  switch (block.block_type.toLowerCase()) {
    case "listitem":
      return removeTerminalId(
        block.content.replace(/^(?:[-+*]|\d+[.)])[ \t]+/, ""),
      );
    case "heading":
      return removeTerminalId(
        block.content.replace(/^#{1,6}[ \t]+/, ""),
      );
    case "blockquote":
      return removeTerminalId(block.content.replace(/^>[ \t]?/, ""));
    case "code":
      return removeCodeFence(removeTerminalId(block.content));
    default:
      return removeTerminalId(block.content);
  }
}

function UnavailableBlock({
  className,
  onRetry,
}: {
  className?: string;
  onRetry?: () => void;
}) {
  return (
    <span
      role="group"
      className={cn(
        "inline-flex items-baseline gap-1 text-muted-foreground",
        className,
      )}
    >
      <span>Referenced block unavailable</span>
      {onRetry ? (
        <button
          type="button"
          className="underline decoration-1 underline-offset-2 hover:decoration-2"
          onClick={onRetry}
        >
          Retry
        </button>
      ) : null}
    </span>
  );
}

export function BlockTransclusion({
  blockId,
  onOpenSource,
  className,
}: BlockTransclusionProps) {
  const { data, isPending, isError, refetch } = useBlock(blockId);

  if (isPending) {
    return (
      <span
        role="status"
        className={cn("text-muted-foreground", className)}
      >
        Loading referenced block
      </span>
    );
  }

  if (isError) {
    return (
      <UnavailableBlock
        className={className}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  if (!data) return <UnavailableBlock className={className} />;

  const content = blockDisplayContent(data);
  if (content.trim().length === 0) {
    return <UnavailableBlock className={className} />;
  }

  const sourceName = data.page_title || data.page_path;
  return (
    <span role="group" className={cn("inline-flex max-w-full", className)}>
      <button
        type="button"
        aria-label={`Open referenced block in ${sourceName}`}
        className="max-w-full cursor-pointer text-left underline decoration-dotted underline-offset-2 hover:decoration-solid"
        onClick={() => onOpenSource(data)}
      >
        {content}
      </button>
    </span>
  );
}
