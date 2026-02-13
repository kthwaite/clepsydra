import type { RenderElementProps } from "slate-react";
import type { CodeBlockElement as CodeBlockElementType } from "#/editor/types";

type Props = RenderElementProps & { element: CodeBlockElementType };

export function CodeBlockElement({ attributes, children, element }: Props) {
  return (
    <div {...attributes}>
      <pre className="overflow-x-auto border border-border bg-muted p-4 font-mono text-sm">
        {element.language && (
          <span
            contentEditable={false}
            className="mb-2 block text-xs text-muted-foreground select-none"
          >
            {element.language}
          </span>
        )}
        <code>{children}</code>
      </pre>
    </div>
  );
}
