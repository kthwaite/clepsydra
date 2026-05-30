import type { RenderElementProps } from "slate-react";
import type { CodeBlockElement as CodeBlockElementType } from "#/editor/types";

type Props = RenderElementProps & { element: CodeBlockElementType };

export function CodeBlockElement({ attributes, children, element }: Props) {
  const lang = (element.language || "txt").toUpperCase();
  return (
    <div {...attributes} className="cl-codeblock border border-rule bg-paper-2">
      <div
        contentEditable={false}
        className="cl-mono flex select-none items-center justify-between border-b border-rule bg-paper px-3 py-1 text-[9px] uppercase tracking-[0.18em] text-ink-mute"
      >
        <span>Code</span>
        <span className="text-accent">{lang}</span>
      </div>
      <pre className="cl-noscroll overflow-x-auto px-4 py-3 font-mono text-[12.5px] leading-[1.5] text-ink">
        <code>{children}</code>
      </pre>
    </div>
  );
}
