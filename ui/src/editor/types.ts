import type { BaseEditor, Descendant } from "slate";
import type { HistoryEditor } from "slate-history";
import type { ReactEditor } from "slate-react";

// --- Element types ---

export interface ParagraphElement {
  type: "paragraph";
  blockId?: string;
  properties?: Record<string, string>;
  children: Descendant[];
}

export interface HeadingElement {
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  blockId?: string;
  properties?: Record<string, string>;
  children: Descendant[];
}

export interface CodeBlockElement {
  type: "code-block";
  language?: string;
  blockId?: string;
  properties?: Record<string, string>;
  children: CustomText[];
}

export interface BlockquoteElement {
  type: "blockquote";
  blockId?: string;
  properties?: Record<string, string>;
  children: Descendant[];
}

export interface BulletedListElement {
  type: "bulleted-list";
  children: ListItemElement[];
}

export interface NumberedListElement {
  type: "numbered-list";
  children: ListItemElement[];
}

export interface ListItemElement {
  type: "list-item";
  checked?: boolean | null;
  blockId?: string;
  properties?: Record<string, string>;
  collapsed?: boolean;
  children: Descendant[];
}

export interface ThematicBreakElement {
  type: "thematic-break";
  children: CustomText[];
}

export interface WikilinkElement {
  type: "wikilink";
  target: string;
  alias?: string;
  children: CustomText[];
}

export interface LinkElement {
  type: "link";
  url: string;
  children: Descendant[];
}

export type CustomElement =
  | ParagraphElement
  | HeadingElement
  | CodeBlockElement
  | BlockquoteElement
  | BulletedListElement
  | NumberedListElement
  | ListItemElement
  | ThematicBreakElement
  | WikilinkElement
  | LinkElement;

// --- Text type ---

export interface CustomText {
  text: string;
  bold?: true;
  italic?: true;
  code?: true;
}

// --- Editor type ---

export type CustomEditor = BaseEditor & ReactEditor & HistoryEditor;

// --- Module augmentation ---

declare module "slate" {
  interface CustomTypes {
    Editor: CustomEditor;
    Element: CustomElement;
    Text: CustomText;
  }
}
