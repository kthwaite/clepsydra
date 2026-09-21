import { useMemo } from "react";
import { attachmentUrl, useAttachments } from "#/api/attachments";
import { MarkdownRenderer } from "#/components/MarkdownRenderer";

interface BaseRenderedMarkdownProps {
  content: string;
  pagePath?: string;
}

function DestinationMarkdown({ content, pagePath }: BaseRenderedMarkdownProps) {
  const inventory = useAttachments();
  const attachmentPaths = useMemo(
    () =>
      new Map(
        (inventory.data ?? []).map((attachment) => [
          attachment.vault_path,
          attachmentUrl(attachment.path),
        ]),
      ),
    [inventory.data],
  );
  return (
    <MarkdownRenderer
      content={content}
      pagePath={pagePath}
      attachmentPaths={attachmentPaths}
      restricted
    />
  );
}

export function BaseRenderedMarkdown({
  content,
  pagePath,
}: BaseRenderedMarkdownProps) {
  return (
    <div className="font-sans whitespace-normal">
      {pagePath ? (
        <DestinationMarkdown content={content} pagePath={pagePath} />
      ) : (
        <MarkdownRenderer content={content} restricted />
      )}
    </div>
  );
}
