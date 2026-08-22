import { Editor, type Path, Text, Transforms } from "slate";
import {
  BASE_EMBED_RECOVERY_BLOCK,
  BASE_EMBED_RECOVERY_ERROR,
  baseEmbedToMdast,
  isCanonicalBaseEmbedConfig,
} from "#/editor/convert/baseEmbedMarkdown";
import { BaseEmbedElement as BaseEmbedElementRenderer } from "../../elements/BaseEmbedElement";
import type { ElementDescriptor } from "../descriptor";
import type {
  BaseEmbedElement,
  ConfiguredBaseEmbedElement,
  InvalidBaseEmbedElement,
  UnconfiguredBaseEmbedElement,
} from "../types";

export type BaseEmbedCreateProps =
  | { status?: "unconfigured" }
  | Omit<ConfiguredBaseEmbedElement, "type" | "children">
  | Omit<InvalidBaseEmbedElement, "type" | "children">;

export function makeBaseEmbed(): UnconfiguredBaseEmbedElement;
export function makeBaseEmbed(
  props: Omit<ConfiguredBaseEmbedElement, "type" | "children">,
): ConfiguredBaseEmbedElement;
export function makeBaseEmbed(
  props: Omit<InvalidBaseEmbedElement, "type" | "children">,
): InvalidBaseEmbedElement;
export function makeBaseEmbed(props: BaseEmbedCreateProps): BaseEmbedElement;
export function makeBaseEmbed(
  props: BaseEmbedCreateProps = {},
): BaseEmbedElement {
  if (props.status === "configured") {
    const { status, base, view, filter, sort, limit, display, width } = props;
    return {
      type: "base-embed",
      status,
      base,
      view,
      ...(filter === undefined ? {} : { filter }),
      ...(sort === undefined ? {} : { sort }),
      ...(limit === undefined ? {} : { limit }),
      ...(display === undefined ? {} : { display }),
      ...(width === undefined ? {} : { width }),
      children: [{ text: "" }],
    };
  }
  if (props.status === "invalid") {
    return {
      type: "base-embed",
      status: "invalid",
      rawBlock: props.rawBlock,
      parseError: props.parseError,
      children: [{ text: "" }],
    };
  }
  return {
    type: "base-embed",
    status: "unconfigured",
    children: [{ text: "" }],
  };
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function hasValidStateShape(value: Record<string, unknown>): boolean {
  if (value.status === "unconfigured") {
    return hasExactKeys(value, ["type", "status", "children"]);
  }
  if (value.status === "invalid") {
    return (
      hasExactKeys(value, [
        "type",
        "status",
        "rawBlock",
        "parseError",
        "children",
      ]) &&
      typeof value.rawBlock === "string" &&
      typeof value.parseError === "string"
    );
  }
  if (value.status !== "configured") return false;
  if (
    !hasExactKeys(
      value,
      ["type", "status", "base", "view", "children"],
      ["filter", "sort", "limit", "display", "width"],
    )
  ) {
    return false;
  }
  return isCanonicalBaseEmbedConfig({
    base: value.base,
    view: value.view,
    ...(Object.hasOwn(value, "filter") ? { filter: value.filter } : {}),
    ...(Object.hasOwn(value, "sort") ? { sort: value.sort } : {}),
    ...(Object.hasOwn(value, "limit") ? { limit: value.limit } : {}),
    ...(Object.hasOwn(value, "display") ? { display: value.display } : {}),
    ...(Object.hasOwn(value, "width") ? { width: value.width } : {}),
  });
}

function replaceNode(
  editor: Editor,
  path: Path,
  replacement: BaseEmbedElement,
): void {
  Editor.withoutNormalizing(editor, () => {
    Transforms.removeNodes(editor, { at: path, voids: true });
    Transforms.insertNodes(editor, replacement, { at: path, voids: true });
  });
}

export const baseEmbedDescriptor: ElementDescriptor<BaseEmbedElement> = {
  type: "base-embed",
  kind: "void-block",
  create: (props) => makeBaseEmbed(props as BaseEmbedCreateProps),
  render: (props) => <BaseEmbedElementRenderer {...props} />,
  normalize: ([node, path], editor) => {
    const persisted = node as unknown as Record<string, unknown>;
    if (!hasValidStateShape(persisted)) {
      replaceNode(editor, path, {
        type: "base-embed",
        status: "invalid",
        rawBlock: BASE_EMBED_RECOVERY_BLOCK,
        parseError: BASE_EMBED_RECOVERY_ERROR,
        children: [{ text: "" }],
      });
      return true;
    }

    const child = node.children[0];
    const childIsEmptyText =
      node.children.length === 1 &&
      Text.isText(child) &&
      child.text === "" &&
      Object.keys(child).length === 1;
    if (!childIsEmptyText) {
      replaceNode(editor, path, {
        ...node,
        children: [{ text: "" }],
      });
      return true;
    }
    return false;
  },
  toMdast: baseEmbedToMdast,
};
