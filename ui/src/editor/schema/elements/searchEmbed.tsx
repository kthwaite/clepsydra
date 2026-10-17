import { Editor, Text, Transforms } from "slate";
import {
  searchConfigError,
  searchEmbedToMdast,
} from "#/editor/convert/searchEmbedMarkdown";
import { SearchEmbedElement as SearchEmbedRenderer } from "#/editor/elements/SearchEmbedElement";
import type { ElementDescriptor } from "../descriptor";
import type { SearchEmbedElement } from "../types";

export function makeSearchEmbed(): SearchEmbedElement {
  return {
    type: "search-embed",
    status: "unconfigured",
    children: [{ text: "" }],
  };
}

export const searchEmbedDescriptor: ElementDescriptor<SearchEmbedElement> = {
  type: "search-embed",
  kind: "void-block",
  create: makeSearchEmbed,
  render: (props) => <SearchEmbedRenderer {...props} />,
  normalize: ([node, path], editor) => {
    const error =
      node.status === "configured"
        ? searchConfigError({
            query: node.query,
            ...(node.limit === undefined ? {} : { limit: node.limit }),
          })
        : node.status === "unconfigured" ||
            (node.status === "invalid" &&
              typeof node.rawBlock === "string" &&
              typeof node.source === "string" &&
              typeof node.parseError === "string")
          ? undefined
          : "Invalid persisted search embed.";
    const child = node.children[0];
    if (
      !error &&
      node.children.length === 1 &&
      Text.isText(child) &&
      child.text === "" &&
      Object.keys(child).length === 1
    )
      return false;
    const replacement: SearchEmbedElement = error
      ? {
          type: "search-embed",
          status: "invalid",
          rawBlock: "```search\n```\n",
          source: "",
          parseError: error,
          children: [{ text: "" }],
        }
      : { ...node, children: [{ text: "" }] };
    Editor.withoutNormalizing(editor, () => {
      Transforms.removeNodes(editor, { at: path, voids: true });
      Transforms.insertNodes(editor, replacement, { at: path, voids: true });
    });
    return true;
  },
  toMdast: searchEmbedToMdast,
};
