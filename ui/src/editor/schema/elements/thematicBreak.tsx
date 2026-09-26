import type { ThematicBreak } from "mdast";
import type { ElementDescriptor } from "../descriptor";
import type { ThematicBreakElement } from "../types";

export const thematicBreakDescriptor: ElementDescriptor<ThematicBreakElement> =
  {
    type: "thematic-break",
    kind: "void-block",
    create: () => ({ type: "thematic-break", children: [{ text: "" }] }),
    render: ({ attributes, children }) => (
      // A faint decorative mark (spec decision 5: no rule lines); the hidden
      // <hr> keeps the separator for assistive tech.
      <div
        {...attributes}
        contentEditable={false}
        className="my-10 flex select-none items-center justify-center gap-3"
      >
        <hr className="sr-only" />
        {[0, 1, 2].map((mark) => (
          <span
            key={mark}
            aria-hidden="true"
            data-break-mark=""
            className="size-[5px] rounded-[1px] bg-faint"
          />
        ))}
        {children}
      </div>
    ),
    toMdast: () => {
      const tb: ThematicBreak = { type: "thematicBreak" };
      return tb;
    },
  };

export const makeThematicBreak = thematicBreakDescriptor.create;
