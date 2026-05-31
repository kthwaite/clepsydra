import type { Descendant, Editor, NodeEntry } from "slate";
import type { RenderElementProps } from "slate-react";
import type { BlockContent, ListItem, PhrasingContent, RootContent } from "mdast";
import type { CustomElement, CustomText, ElementType, ListItemElement } from "./types";

export type ElementKind = "block" | "inline" | "void-block" | "inline-void";

export function kindIsInline(kind: ElementKind): boolean {
  return kind === "inline" || kind === "inline-void";
}

export function kindIsVoid(kind: ElementKind): boolean {
  return kind === "void-block" || kind === "inline-void";
}

/** Recursive serialization helpers passed to each descriptor's toMdast. */
export interface SerializeCtx {
  inlineChildren(children: Descendant[]): PhrasingContent[];
  blockChildren(children: Descendant[]): BlockContent[];
  appendBlockMetadata(
    children: PhrasingContent[],
    element: { properties?: Record<string, string>; blockId?: string },
  ): void;
  listItem(node: ListItemElement): ListItem;
}

export interface ElementDescriptor<T extends CustomElement = CustomElement> {
  type: T["type"];
  kind: ElementKind;
  /** Build a fully-formed node (owns default/empty children). */
  create(props: CreateProps<T>): T;
  /** Render; receives the narrowed element. */
  render(props: RenderElementProps & { element: T }): React.JSX.Element;
  /** Return true if this rule claims the node (skip Slate's default). */
  normalize?(entry: NodeEntry<T>, editor: Editor): boolean;
  /** Serialize this node to an mdast node (serialize-out only). */
  toMdast?(node: T, ctx: SerializeCtx): RootContent;
}

/** create() input: the node minus type/children (children defaulted by the factory). */
export type CreateProps<T extends CustomElement> = Omit<T, "type" | "children"> &
  Partial<Pick<T, "children">>;

export type { CustomElement, CustomText, ElementType };
