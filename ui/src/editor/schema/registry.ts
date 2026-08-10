import type { ElementDescriptor } from "./descriptor";
import { blockquoteDescriptor } from "./elements/blockquote";
import { baseEmbedDescriptor } from "./elements/baseEmbed";
import { blockRefDescriptor } from "./elements/blockRef";
import { conversationTurnDescriptor } from "./elements/conversationTurn";
import { codeBlockDescriptor } from "./elements/codeBlock";
import { footnoteDefDescriptor } from "./elements/footnoteDef";
import { footnoteRefDescriptor } from "./elements/footnoteRef";
import { headingDescriptor } from "./elements/heading";
import { imageDescriptor } from "./elements/image";
import { journalTimeDescriptor } from "./elements/journalTime";
import { linkDescriptor } from "./elements/link";
import {
  bulletedListDescriptor,
  listItemDescriptor,
  numberedListDescriptor,
} from "./elements/list";
import {
  inlineMathDescriptor,
  mathBlockDescriptor,
} from "./elements/math";
import { paragraphDescriptor } from "./elements/paragraph";
import { thematicBreakDescriptor } from "./elements/thematicBreak";
import { wikilinkDescriptor } from "./elements/wikilink";
import type { CustomElement, ElementType } from "./types";

const ALL: ElementDescriptor[] = [
  paragraphDescriptor,
  headingDescriptor,
  codeBlockDescriptor,
  conversationTurnDescriptor,
  blockquoteDescriptor,
  bulletedListDescriptor,
  numberedListDescriptor,
  listItemDescriptor,
  thematicBreakDescriptor,
  journalTimeDescriptor,
  wikilinkDescriptor,
  inlineMathDescriptor,
  linkDescriptor,
  imageDescriptor,
  blockRefDescriptor,
  footnoteRefDescriptor,
  footnoteDefDescriptor,
  mathBlockDescriptor,
  baseEmbedDescriptor,
];

export const REGISTRY = Object.fromEntries(
  ALL.map((d) => [d.type, d]),
) as Record<ElementType, ElementDescriptor>;

export function getDescriptor<T extends ElementType>(
  type: T,
): ElementDescriptor<Extract<CustomElement, { type: T }>> | undefined;
export function getDescriptor(type: ElementType): ElementDescriptor | undefined;
export function getDescriptor(
  type: ElementType,
): ElementDescriptor | undefined {
  return REGISTRY[type];
}
