import type { BlockResponse } from "#/api/blocks";
import { isBlockNotFound, useBlock } from "#/api/blocks";
import { cn } from "#/lib/cn";

export interface BlockTransclusionProps {
  blockId: string;
  onOpenSource: (block: BlockResponse) => void;
  className?: string;
}

export function blockDisplayContent(block: BlockResponse): string {
  return block.content;
}

function UnavailableBlock({
  className,
  onRetry,
}: {
  className?: string;
  onRetry?: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: This transclusion is phrasing content inside Slate and Markdown spans; a fieldset would create invalid HTML, so an ARIA group is the valid inline semantic.
    <span
      role="group"
      aria-label="Referenced block"
      className={cn(
        "inline-flex min-w-0 items-baseline gap-1 text-muted-foreground",
        className,
      )}
    >
      <span>Referenced block unavailable</span>
      {onRetry ? (
        <button
          type="button"
          contentEditable={false}
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
  const { data, error, isPending, isError, refetch } = useBlock(blockId);

  if (isPending) {
    return (
      <span role="status" className={cn("text-muted-foreground", className)}>
        Loading referenced block
      </span>
    );
  }

  if (isError && isBlockNotFound(error)) {
    return <UnavailableBlock className={className} />;
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
    // biome-ignore lint/a11y/useSemanticElements: This transclusion is phrasing content inside Slate and Markdown spans; a fieldset would create invalid HTML, so an ARIA group is the valid inline semantic.
    <span
      role="group"
      aria-label="Referenced block"
      className={cn("inline-flex max-w-full items-baseline gap-1", className)}
    >
      <span className="max-w-full">{content}</span>
      <button
        type="button"
        contentEditable={false}
        aria-label={`Open referenced block in ${sourceName}`}
        className="shrink-0 cursor-pointer text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground hover:decoration-solid"
        onClick={() => onOpenSource(data)}
      >
        Source
      </button>
    </span>
  );
}
