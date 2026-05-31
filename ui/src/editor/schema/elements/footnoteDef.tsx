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
      className="cl-footnote-def mt-1 flex gap-2 border-t border-rule-soft pt-1 text-[0.85em] text-ink-mute"
    >
      <span contentEditable={false} className="cl-mono text-accent select-none">
        [{element.identifier}]
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  ),
};

export const makeFootnoteDef = footnoteDefDescriptor.create;
