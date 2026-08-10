import type { Image, Paragraph } from "mdast";
import { resolveResourceUrl } from "#/lib/resourceUrl";
import type { ElementDescriptor } from "../descriptor";
import type { ImageElement } from "../types";
import { makeVoidIntegrityRule } from "./voidInline";

export const imageDescriptor: ElementDescriptor<ImageElement> = {
  type: "image",
  kind: "inline-void",
  create: ({ url, alt = "", title }) => ({
    type: "image",
    url,
    alt,
    title,
    children: [{ text: "" }],
  }),
  render: ({ attributes, children, element }) => (
    <span {...attributes}>
      <span
        contentEditable={false}
        className="mx-0.5 inline-block align-middle"
      >
        <img
          src={resolveResourceUrl(element.url)}
          alt={element.alt}
          title={element.title}
          className="max-h-[32rem] max-w-full border border-border object-contain"
        />
      </span>
      {children}
    </span>
  ),
  normalize: makeVoidIntegrityRule<ImageElement>("url"),
  toMdast: (node) => {
    const image: Image = {
      type: "image",
      url: node.url,
      alt: node.alt,
      title: node.title ?? null,
    };
    const paragraph: Paragraph = { type: "paragraph", children: [image] };
    return paragraph;
  },
};

export const makeImage = imageDescriptor.create;
