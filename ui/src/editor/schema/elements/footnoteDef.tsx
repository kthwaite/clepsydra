import type { RootContent } from "mdast";
import type { ElementDescriptor } from "../descriptor";
import type { FootnoteDefElement } from "../types";

export const footnoteDefDescriptor: ElementDescriptor<FootnoteDefElement> = {
  type: "footnote-def",
  kind: "block",
  create: ({ identifier, children = [{ text: "" }] }) => ({
    type: "footnote-def",
    identifier,
    children,
  }),
  render: ({ attributes, children, element }) => (
    <div
      {...attributes}
      className="mt-2 flex gap-2.5 text-[14px] leading-[1.6] text-mute"
    >
      <span
        contentEditable={false}
        className="shrink-0 select-none tabular-nums text-accent"
      >
        [{element.identifier}]
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  ),
  toMdast: (node, ctx) =>
    // footnoteDefinition is a GFM extension node, not in the base mdast RootContent union.
    ({
      type: "footnoteDefinition",
      identifier: node.identifier,
      label: node.identifier,
      children: ctx.blockChildren(node.children),
    }) as unknown as RootContent,
};

export const makeFootnoteDef = footnoteDefDescriptor.create;
