import type { RenderLeafProps } from "slate-react";
import { TOKEN_COLOR } from "../decorate-code";

export function renderLeaf({ attributes, children, leaf }: RenderLeafProps) {
  if (leaf.code) {
    children = (
      <code className="bg-muted px-1 py-0.5 font-mono text-sm">{children}</code>
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
  if (leaf.token) {
    children = (
      <span style={{ color: TOKEN_COLOR[leaf.token] ?? "inherit" }}>
        {children}
      </span>
    );
  }
  return <span {...attributes}>{children}</span>;
}
