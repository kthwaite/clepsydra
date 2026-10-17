import { RenderedWikilink } from "#/components/RenderedWikilink";
import { useOpenTab } from "#/hooks/useOpenTab";
import { todoAssigneeReference } from "#/lib/todoAssignee";

/** Uses ordinary wikilink navigation, including unresolved manual references. */
export function TodoAssignee({ value }: { value: string }) {
  const openTab = useOpenTab();
  const reference = todoAssigneeReference(value);
  if (!reference) return <span>Assignee: {value}</span>;
  return (
    <span className="text-[12.5px] text-mute">
      Assignee:{" "}
      <RenderedWikilink
        target={reference.target}
        markDangling={false}
        onOpen={(path, label, target) => openTab("page", path, label, target)}
      >
        {reference.alias ?? reference.target}
      </RenderedWikilink>
    </span>
  );
}
