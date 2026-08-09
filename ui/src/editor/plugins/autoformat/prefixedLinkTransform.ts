import {
  Editor,
  type Path,
  Range,
  Element as SlateElement,
  Text,
  Transforms,
} from "slate";
import { HistoryEditor } from "slate-history";
import { expandPrefixedLink } from "#/editor/prefixedExternalLinks";
import type { CustomElement } from "#/editor/types";
import { selectTextAfterInline } from "./inlineTransforms";

const QUOTED_CANDIDATE =
  /(?:^|[\s\p{P}])(?<candidate>(?<prefix>[A-Za-z]+):"(?<value>[^"\r\n]+)")$/u;
const OPEN_QUOTED_CANDIDATE =
  /(?:^|[\s\p{P}])(?<candidate>(?<prefix>[A-Za-z]+):"(?<value>[^"\r\n]+))$/u;
const BARE_CANDIDATE =
  /(?:^|[\s\p{P}])(?<candidate>(?<prefix>[A-Za-z]+):(?<value>\S+))$/u;

const PROTECTED_ANCESTOR_TYPES: Record<string, true> = {
  "code-block": true,
  link: true,
  wikilink: true,
  "block-ref": true,
  "footnote-ref": true,
};

type PrefixedLinkCandidate = {
  path: Path;
  start: number;
  end: number;
  prefix: string;
  value: string;
};

function candidateAtCaret(
  editor: Editor,
  pattern: RegExp,
): PrefixedLinkCandidate | null {
  const { selection } = editor;
  if (!selection || !Range.isCollapsed(selection)) return null;

  const { anchor } = selection;
  const [leaf] = Editor.node(editor, anchor.path);
  if (!Text.isText(leaf) || leaf.code === true) return null;

  const protectedAncestor = Editor.above(editor, {
    at: anchor,
    match: (node) =>
      SlateElement.isElement(node) &&
      Object.hasOwn(PROTECTED_ANCESTOR_TYPES, node.type),
  });
  if (protectedAncestor) return null;

  const textBefore = leaf.text.slice(0, anchor.offset);
  const match = pattern.exec(textBefore);
  const candidate = match?.groups?.candidate;
  const prefix = match?.groups?.prefix;
  const value = match?.groups?.value;
  if (!candidate || !prefix || !value) return null;

  return {
    path: anchor.path,
    start: anchor.offset - candidate.length,
    end: anchor.offset,
    prefix,
    value,
  };
}

function replaceCandidate(
  editor: Editor,
  candidate: PrefixedLinkCandidate,
  completeAction: () => void,
): boolean {
  const expanded = expandPrefixedLink(candidate.prefix, candidate.value);
  if (!expanded) return false;

  HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
    Editor.withoutNormalizing(editor, () => {
      Transforms.select(editor, {
        anchor: { path: candidate.path, offset: candidate.start },
        focus: { path: candidate.path, offset: candidate.end },
      });
      Transforms.delete(editor);
      Transforms.insertNodes(editor, {
        type: "link",
        url: expanded.url,
        children: [{ text: expanded.label }],
      } as CustomElement);
      const linkPath = editor.selection?.anchor.path.slice(0, -1);
      if (linkPath) selectTextAfterInline(editor, linkPath);
      completeAction();
    });
  });

  return true;
}

export function tryPrefixedLinkTextTransform(
  editor: Editor,
  trigger: '"' | " ",
  closerConsumed = false,
): boolean {
  const pattern =
    trigger === " "
      ? BARE_CANDIDATE
      : closerConsumed
        ? QUOTED_CANDIDATE
        : OPEN_QUOTED_CANDIDATE;
  const candidate = candidateAtCaret(editor, pattern);
  if (!candidate) return false;

  return replaceCandidate(editor, candidate, () => {
    if (trigger === " ") Transforms.insertText(editor, " ");
  });
}

export function tryPrefixedLinkBreakTransform(
  editor: Editor,
  insertBreak: () => void,
): boolean {
  const candidate = candidateAtCaret(editor, BARE_CANDIDATE);
  if (!candidate) return false;

  return replaceCandidate(editor, candidate, insertBreak);
}
