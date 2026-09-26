import type { CSSProperties } from "react";
import type { RenderLeafProps } from "slate-react";
import { TOKEN_COLOR } from "../decorate-code";

export function renderLeaf({ attributes, children, leaf }: RenderLeafProps) {
  if (leaf.code) {
    children = (
      <code
        spellCheck={false}
        className="rounded-[5px] bg-sink px-[5px] py-px text-[0.8em] text-ink"
      >
        {children}
      </code>
    );
  }
  if (leaf.bold) {
    children = <strong>{children}</strong>;
  }
  if (leaf.italic) {
    children = <em>{children}</em>;
  }
  if (leaf.underline) {
    children = <u>{children}</u>;
  }
  if (leaf.strikethrough) {
    children = <del>{children}</del>;
  }
  if (leaf.superscript) {
    children = <sup>{children}</sup>;
  }
  if (leaf.subscript) {
    children = <sub>{children}</sub>;
  }
  const style: CSSProperties | undefined =
    leaf.color || leaf.backgroundColor || leaf.token
      ? {
          color:
            leaf.color ||
            (leaf.token ? (TOKEN_COLOR[leaf.token] ?? "inherit") : undefined),
          backgroundColor: leaf.backgroundColor,
        }
      : undefined;
  return (
    <span {...attributes} style={style}>
      {children}
    </span>
  );
}
