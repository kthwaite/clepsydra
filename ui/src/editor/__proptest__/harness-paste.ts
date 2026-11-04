/**
 * Discovery harness for structural insertion and conversion into lists: paste,
 * copy then paste, selection-bubble list actions, slash conversions and task
 * property edits. Not production code.
 *
 * Each op mirrors the production call path as closely as a headless editor
 * allows. Where the production path is inside a React component (SlateEditor's
 * executeSlashCommand, TaskPropertyPopover's commit, the checkbox onChange,
 * SelectionBubbleMenu's applyToPreservedRange) the op copies those few lines;
 * the copies name their source.
 */
import fc from "fast-check";
import {
  type Descendant,
  Editor,
  type Element,
  Node,
  Range,
  Element as SlateElement,
  Transforms,
} from "slate";
import { HistoryEditor } from "slate-history";
import { slashCommandToConversion } from "../SlateEditor";
import {
  applyBlockConversion,
  applySelectionList,
} from "../transforms/blockConversions";
import {
  type Caret,
  clone,
  type Op as BaseOp,
  applyOp as applyBaseOp,
} from "./harness";

export type ListType = "bulleted-list" | "numbered-list";

export type PasteOp =
  | BaseOp
  /** ⌘V with only text/plain on the clipboard. */
  | { k: "pasteMd"; md: string }
  /** ⌘C of the current selection: Slate's own getFragment payload. */
  | { k: "copy" }
  /** ⌘V of the last copied fragment. */
  | { k: "pasteFrag" }
  /** Selection bubble's list buttons (needs an expanded selection). */
  | { k: "selList"; list: ListType }
  /** Typing `/` in the caret's paragraph; a non-empty one is cleared first. */
  | { k: "slashType" }
  /** Choosing a command from the slash menu after `slashType`. */
  | { k: "slashApply"; id: string }
  /** TaskPropertyPopover commit on the caret's item. */
  | { k: "prop"; key: string; value: string }
  | { k: "propClear" }
  /** Task checkbox's onChange. */
  | { k: "check" };

const clipboards = new WeakMap<Editor, Descendant[]>();

/** Same encoding slate-dom's setFragmentData writes and insertFragmentData reads. */
export function encodeFragment(fragment: Descendant[]): string {
  return window.btoa(encodeURIComponent(JSON.stringify(fragment)));
}

export function dataTransfer(items: Record<string, string>): DataTransfer {
  return {
    getData: (t: string) => items[t] ?? "",
    types: Object.keys(items),
    files: [],
    items: [],
  } as unknown as DataTransfer;
}

export function pasteMarkdown(editor: Editor, md: string): void {
  editor.insertData(dataTransfer({ "text/plain": md }));
}

export function pasteFragment(editor: Editor, fragment: Descendant[]): void {
  editor.insertData(
    dataTransfer({
      "application/x-slate-fragment": encodeFragment(fragment),
      "text/plain": fragment.map((n) => Node.string(n)).join("\n"),
    }),
  );
}

/** Reaches the only state the slash trigger fires in: "/" as the whole text. */
export function slashType(editor: Editor): void {
  const above = Editor.above(editor, {
    match: (n) => SlateElement.isElement(n) && n.type === "paragraph",
  });
  if (!above) return;
  const [para, paraPath] = above;
  if (Node.string(para) !== "" || para.children.length > 1) {
    Transforms.delete(editor, {
      at: {
        anchor: Editor.start(editor, paraPath),
        focus: Editor.end(editor, paraPath),
      },
      voids: true,
    });
  }
  Transforms.select(editor, Editor.end(editor, paraPath));
  Editor.insertText(editor, "/");
}

/** SlateEditor.executeSlashCommand, minus the React state. */
export function slashApply(editor: Editor, id: string): void {
  const { selection } = editor;
  if (!selection) return;
  const above = Editor.above(editor, {
    match: (n) => SlateElement.isElement(n) && n.type === "paragraph",
  });
  if (!above || Node.string(above[0]) !== "/") return;
  const conversion = slashCommandToConversion(id);
  if (!conversion) return;
  applyBlockConversion(editor, {
    at: above[1],
    deleteRange: {
      anchor: { path: selection.anchor.path, offset: 0 },
      focus: selection.focus,
    },
    conversion,
  });
}

/** Both steps, for reproductions. */
export function slash(editor: Editor, id: string): void {
  slashType(editor);
  slashApply(editor, id);
}

function itemAbove(editor: Editor) {
  return Editor.above(editor, {
    match: (n) => SlateElement.isElement(n) && n.type === "list-item",
  });
}

export function applyPasteOp(editor: Editor, op: PasteOp): void {
  switch (op.k) {
    case "pasteMd":
      pasteMarkdown(editor, op.md);
      return;
    case "copy":
      if (editor.selection && Range.isExpanded(editor.selection)) {
        clipboards.set(editor, clone(editor.getFragment()));
      }
      return;
    case "pasteFrag": {
      const f = clipboards.get(editor);
      if (f) pasteFragment(editor, clone(f));
      return;
    }
    case "selList":
      // SelectionBubbleMenu.applyToPreservedRange.
      if (editor.selection && Range.isExpanded(editor.selection)) {
        const list = op.list;
        Editor.withoutNormalizing(editor, () => {
          applySelectionList(editor, list);
        });
      }
      return;
    case "slashType":
      slashType(editor);
      return;
    case "slashApply":
      slashApply(editor, op.id);
      return;
    case "prop": {
      // TaskPropertyPopover.commit.
      const item = itemAbove(editor);
      if (!item) return;
      const el = item[0] as {
        checked?: boolean | null;
        properties?: Record<string, string>;
      };
      // ListItem renders the popover's controls only for a task.
      if (el.checked === undefined || el.checked === null) return;
      const { key, value } = op;
      const props = el.properties;
      HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
        Transforms.setNodes(
          editor,
          { properties: { ...props, [key]: value } } as Partial<Element>,
          { at: item[1] },
        );
      });
      return;
    }
    case "propClear": {
      const item = itemAbove(editor);
      if (!item) return;
      HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
        Transforms.unsetNodes(editor, "properties" as never, { at: item[1] });
      });
      return;
    }
    case "check": {
      // ListItem's checkbox onChange.
      const item = itemAbove(editor);
      if (!item) return;
      const checked = (item[0] as { checked?: boolean | null }).checked;
      if (checked === undefined || checked === null) return;
      HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
        Transforms.setNodes(editor, { checked: !checked } as Partial<Element>, {
          at: item[1],
        });
      });
      return;
    }
    default:
      applyBaseOp(editor, op);
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Pasted Markdown is written, not sampled from the serializer, so it covers
 * shapes the editor would not emit itself. Labels are uppercase so they cannot
 * collide with the lowercase labels `buildDoc` uses.
 */
const PASTES: readonly string[] = [
  "Pone",
  "Pone\n\nPtwo",
  "- Pone",
  "- Pone\n- Ptwo",
  "- Pone\n- Ptwo\n- Pthree",
  "1. Pone\n2. Ptwo",
  "- [ ] Pone\n- [x] Ptwo",
  "- Pone\n  - Pkid\n- Ptwo",
  "- Pone\n  - Pkid",
  "- Pone\n  - Pkid\n    - Pgrand",
  "- Pone\n\n  Ppar\n- Ptwo",
  "- Pone\n\n  Ppar",
  "- Pone\n-\n- Ptwo",
  "-\n- Ptwo",
  "- Pone\n-",
  "Pone\n\n- Ptwo",
  "- Pone\n\nPtwo",
  "# Phead",
  "# Phead\n\n- Pone",
  "> Pquote",
  "- Pone\n\n1. Ptwo",
  "```\nPcode\n```",
  "- Pone\n\n  ```\n  Pcode\n  ```",
  "---",
  "| Pa | Pb |\n| -- | -- |\n| Pc | Pd |",
  "- Pone ^abc123defg",
  "Pone ^abc123defg",
  "Pone\nPtwo",
  "- Pone\n  Pcont\n- Ptwo",
  "Pone [due:: 2026-11-04]",
  "- [ ] Pone [due:: 2026-11-04]",
  "- [[Plink]]",
  "- **Pbold** Pplain",
];

const SLASH_IDS = [
  "h1",
  "h3",
  "bullet",
  "number",
  "task",
  "quote",
  "code",
  "divider",
];

/**
 * What each popover control can write. Assignee is a <select> of people
 * references plus the current value, so the odd ones stress the round trip more
 * than they model common input.
 */
const PROP_VALUES: Record<string, readonly string[]> = {
  due: ["2026-11-04", "2027-01-31"],
  scheduled: ["2026-11-04"],
  priority: ["A", "B", "C"],
  assignee: [
    "Bob Smith",
    "[[Alice]]",
    "[[Alice|Al]]",
    "a*b*",
    "x_y_z",
    "lt<gt",
    "a`b",
  ],
};

export const PASTE_OP_KINDS = [
  "pasteMd",
  "copyPaste",
  "selList",
  "slash",
  "prop",
  "propClear",
  "check",
  "undo",
  "redo",
  "type",
  "enter",
  "soft",
] as const;
export type PasteOpKind = (typeof PASTE_OP_KINDS)[number];

const arbCaret: fc.Arbitrary<Caret> = fc.oneof(
  fc.record({
    at: fc.constantFrom("start" as const, "end" as const),
    line: fc.nat(40),
  }),
  fc.record({
    at: fc.constant("mid" as const),
    line: fc.nat(40),
    off: fc.nat(8),
  }),
);

const arbRange = fc.record({
  k: fc.constant("range" as const),
  a: arbCaret,
  b: arbCaret,
});
const arbList = fc.constantFrom<ListType>("bulleted-list", "numbered-list");

function arbStep(kinds: readonly PasteOpKind[]): fc.Arbitrary<PasteOp[]> {
  const position: fc.Arbitrary<PasteOp> = fc.oneof(
    { weight: 2, arbitrary: arbCaret.map((c): PasteOp => ({ k: "caret", c })) },
    { weight: 1, arbitrary: arbRange },
  );
  const byKind = (k: PasteOpKind): fc.Arbitrary<PasteOp[]> => {
    switch (k) {
      case "pasteMd":
        return fc
          .tuple(position, fc.constantFrom(...PASTES))
          .map(([p, md]): PasteOp[] => [p, { k: "pasteMd", md }]);
      case "copyPaste":
        return fc
          .tuple(arbRange, arbCaret, fc.boolean())
          .map(([r, c, over]): PasteOp[] =>
            over
              ? [
                  r,
                  { k: "copy" },
                  { k: "range", a: c, b: r.b },
                  { k: "pasteFrag" },
                ]
              : [r, { k: "copy" }, { k: "caret", c }, { k: "pasteFrag" }],
          );
      case "selList":
        return fc
          .tuple(arbRange, arbList, fc.boolean())
          .map(([r, list, twice]): PasteOp[] =>
            twice
              ? [r, { k: "selList", list }, { k: "selList", list }]
              : [r, { k: "selList", list }],
          );
      case "slash":
        return fc
          .tuple(arbCaret, fc.constantFrom(...SLASH_IDS))
          .map(([c, id]): PasteOp[] => [
            { k: "caret", c },
            { k: "slashType" },
            { k: "slashApply", id },
          ]);
      case "prop":
        return fc
          .tuple(
            arbCaret,
            fc
              .constantFrom(...Object.keys(PROP_VALUES))
              .chain((key) =>
                fc
                  .constantFrom(...PROP_VALUES[key])
                  .map((value) => ({ key, value })),
              ),
          )
          .map(([c, { key, value }]): PasteOp[] => [
            { k: "caret", c },
            { k: "prop", key, value },
          ]);
      case "propClear":
        return arbCaret.map((c): PasteOp[] => [
          { k: "caret", c },
          { k: "propClear" },
        ]);
      case "check":
        return arbCaret.map((c): PasteOp[] => [
          { k: "caret", c },
          { k: "check" },
        ]);
      case "type":
        return fc
          .tuple(arbCaret, fc.constantFrom("a", "b", " "))
          .map(([c, ch]): PasteOp[] => [
            { k: "caret", c },
            { k: "type", ch },
          ]);
      case "enter":
        return arbCaret.map((c): PasteOp[] => [
          { k: "caret", c },
          { k: "enter" },
        ]);
      case "soft":
        return arbCaret.map((c): PasteOp[] => [
          { k: "caret", c },
          { k: "soft" },
        ]);
      default:
        return fc.constant([{ k } as PasteOp]);
    }
  };
  return fc.oneof(...kinds.map(byKind));
}

export function arbPasteOps(
  kinds: readonly PasteOpKind[],
  maxSteps: number,
): fc.Arbitrary<PasteOp[]> {
  return fc
    .array(arbStep(kinds), { minLength: 1, maxLength: maxSteps })
    .map((steps) => steps.flat());
}
