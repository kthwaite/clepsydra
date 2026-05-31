import type { RenderElementProps } from "slate-react";
import { getDescriptor } from "#/editor/schema/registry";

export function renderElement(props: RenderElementProps) {
  const desc = getDescriptor(props.element.type);
  if (desc) {
    // desc is stored erased as ElementDescriptor<CustomElement>; render expects the
    // narrowed element type. The overload on getDescriptor only helps literal-type call
    // sites — at a union-typed dispatch boundary the erased form is returned. One cast
    // here keeps the rest of the codebase cast-free.
    return desc.render(props as never);
  }
  // Unknown type — fall back to a plain paragraph so the doc still renders.
  return <p {...props.attributes}>{props.children}</p>;
}
