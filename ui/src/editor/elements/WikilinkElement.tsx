import type { RenderElementProps } from "slate-react";
import type { WikilinkElement as WikilinkElementType } from "#/editor/types";
import { useOpenTab } from "#/hooks/useOpenTab";

type Props = RenderElementProps & { element: WikilinkElementType };

export function WikilinkElement({ attributes, children, element }: Props) {
  const openTab = useOpenTab();
  const displayText = element.alias ?? element.target;

  return (
    <span {...attributes}>
      <span
        contentEditable={false}
        className="inline cursor-pointer border border-border bg-muted px-1.5 text-sm hover:bg-accent"
        onClick={(e) => {
          e.preventDefault();
          openTab("page", element.target);
        }}
      >
        {displayText}
      </span>
      {children}
    </span>
  );
}
