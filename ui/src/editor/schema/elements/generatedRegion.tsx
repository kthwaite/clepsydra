import type { RootContent } from "mdast";
import { GeneratedRegionElement as GeneratedRegionRenderer } from "#/editor/elements/GeneratedRegionElement";
import type { ElementDescriptor } from "../descriptor";
import type { GeneratedRegionElement } from "../types";

export const generatedRegionDescriptor: ElementDescriptor<GeneratedRegionElement> =
  {
    type: "generated-region",
    kind: "void-block",
    create: (props) =>
      ({
        ...props,
        type: "generated-region",
        children: [{ text: "" }],
      }) as GeneratedRegionElement,
    render: (props) => <GeneratedRegionRenderer {...props} />,
    toMdast: (node) =>
      ({
        type: "generatedRegion",
        rawBlock: node.rawBlock,
      }) as unknown as RootContent,
  };
