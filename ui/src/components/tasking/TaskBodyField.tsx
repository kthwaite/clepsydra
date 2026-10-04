import { usePage } from "#/api/pages";
import { MarkdownRenderer } from "#/components/MarkdownRenderer";
import { EdField } from "./fields";

const IGNORE_PAGE = () => {};

/**
 * The Task page's full markdown body, read-only. Unlike the card
 * description, nothing is stripped or capped: checklist items render as
 * disabled checkboxes. A protected page shows no body.
 */
export function TaskBodyField({
  path,
  onOpenPage,
}: {
  path: string;
  /** Opens a page linked from the body. */
  onOpenPage?: (path: string) => void;
}) {
  const page = usePage(path);
  const body = page.data?.encrypted ? null : (page.data?.body.trim() ?? null);

  let content: React.ReactNode;
  if (page.data?.encrypted) {
    content = <Placeholder>Protected note · open to unlock</Placeholder>;
  } else if (body) {
    content = (
      <div className="min-w-0 break-words text-[14px] leading-[1.6] text-ink-2">
        <MarkdownRenderer
          content={body}
          pagePath={path}
          onOpenPage={onOpenPage ?? IGNORE_PAGE}
        />
      </div>
    );
  } else if (page.data) {
    content = <Placeholder>Empty page</Placeholder>;
  } else if (page.isError) {
    content = <Placeholder>Could not load the page body.</Placeholder>;
  } else {
    content = <Placeholder>Loading…</Placeholder>;
  }

  return (
    <EdField label="Body" hint="Read-only">
      <div data-testid="edit-panel-body">{content}</div>
    </EdField>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return <p className="m-0 text-[13px] text-mute">{children}</p>;
}
