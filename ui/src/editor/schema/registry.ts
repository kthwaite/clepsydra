import type { ElementDescriptor } from "./descriptor";
import type { CustomElement, ElementType } from "./types";
import { paragraphDescriptor } from "./elements/paragraph";
import { headingDescriptor } from "./elements/heading";
import { codeBlockDescriptor } from "./elements/codeBlock";
import { blockquoteDescriptor } from "./elements/blockquote";
import {
  bulletedListDescriptor,
  listItemDescriptor,
  numberedListDescriptor,
} from "./elements/list";
import { thematicBreakDescriptor } from "./elements/thematicBreak";
import { wikilinkDescriptor } from "./elements/wikilink";
import { linkDescriptor } from "./elements/link";
import { blockRefDescriptor } from "./elements/blockRef";
import { footnoteRefDescriptor } from "./elements/footnoteRef";
import { footnoteDefDescriptor } from "./elements/footnoteDef";

const ALL: ElementDescriptor[] = [
  paragraphDescriptor,
  headingDescriptor,
  codeBlockDescriptor,
  blockquoteDescriptor,
  bulletedListDescriptor,
  numberedListDescriptor,
  listItemDescriptor,
  thematicBreakDescriptor,
  wikilinkDescriptor,
  linkDescriptor,
  blockRefDescriptor,
  footnoteRefDescriptor,
  footnoteDefDescriptor,
];

export const REGISTRY = Object.fromEntries(
  ALL.map((d) => [d.type, d]),
) as Record<ElementType, ElementDescriptor>;

export function getDescriptor<T extends ElementType>(
  type: T,
): ElementDescriptor<Extract<CustomElement, { type: T }>> | undefined;
export function getDescriptor(type: ElementType): ElementDescriptor | undefined;
export function getDescriptor(type: ElementType): ElementDescriptor | undefined {
  return REGISTRY[type];
}
